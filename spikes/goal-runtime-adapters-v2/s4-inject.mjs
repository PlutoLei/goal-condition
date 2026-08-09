import { AppServerClient } from './lib/appserver-client.mjs';
import { mkdtempSync, writeFileSync, copyFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const DIAGNOSTIC = 'Postflight failed: ./out.txt missing. Create it with content DONE, then stop.';
// objective 显式禁止无指令创建文件——out.txt 一旦出现，唯一能解释它的输入源就是注入的 DIAGNOSTIC
// （turn/start 首轮输入没提过 out.txt/DONE）。这样才能把"注入触发的工作"和 S2 已证实的
// "goal active 且目标未达成时本就会自动续轮"区分开：单看 turnStarted 计数增长不是充分证据。
const OBJECTIVE = 'Wait for corrective instructions, then follow them exactly. '
  + 'Do not create, modify, or delete any files unless a corrective instruction explicitly tells you to do so.';

async function runTrial(label, items) {
  // 同 S2/S2b：codexHome 与 work 各自独立 mkdtempSync，不共享父目录（workspace-write sandbox 只限写
  // 不限读，避免执行体用相对路径读到 codexHome 里的凭证副本）。
  const codexHome = mkdtempSync(join(tmpdir(), `spike-s4-${label}-codex-home-`));
  const work = mkdtempSync(join(tmpdir(), `spike-s4-${label}-work-`));
  const authSrc = join(homedir(), '.codex', 'auth.json');
  if (existsSync(authSrc)) copyFileSync(authSrc, join(codexHome, 'auth.json'));

  // fix round 1（review Important #1）：Node 的 try/finally 在进程收到 SIGTERM/SIGKILL 时不会执行——
  // 本轮上一次跑错方法名、手动 kill 跑飞的进程，就是绕过 finally、把生产 auth.json 副本残留在
  // /var/folders 下的活证据（见 task-5-report.md ④）。不能靠"跑的人足够警觉"兜底，S6/后续无人
  // 盯守的场景会咬人。把清理逻辑抽成幂等的 cleanup()，同时注册给 finally 和 SIGTERM/SIGINT，
  // 保证外部 kill 也能删掉凭证副本。
  let c = null;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (c) { try { c.stop(); } catch { /* 进程可能已经不在了，best-effort */ } }
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
    console.log(`[${label}] cleaned up:`, codexHome, work);
  };
  const onSignal = (sig) => {
    console.error(`[${label}] received ${sig} — cleaning up credential copy before exit`);
    cleanup();
    process.exit(1);
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  const events = [];
  const countSince = (method, sinceTs) => events.filter((e) => e.method === method && e.t >= sinceTs).length;

  const rec = { label, items, threadId: null };
  try {
    c = new AppServerClient({ mode: 'stdio', codexHome, cwd: work });
    c.onNotification((n) => { events.push({ t: Date.now(), method: n.method }); });
    await c.start(); await c.initialize();
    const { threadId } = await c.threadStart({ ephemeral: false, sandbox: 'workspace-write', cwd: work });
    rec.threadId = threadId;

    rec.set = (await c.rpc('thread/goal/set', { threadId, objective: OBJECTIVE, tokenBudget: 50000 })).result;
    const t0 = Date.now();
    rec.turnStart = (await c.rpc('turn/start', { threadId, input: [{ type: 'text', text: OBJECTIVE }] })).result;

    // 待首轮真正完成再注入（team lead 指示：不能在首轮执行中途插入，否则注入内容可能被首轮
    // 上下文吞掉、判读会混）。轮询而非固定 sleep，最多等 60s。
    let firstTurnDone = false;
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      if (countSince('turn/completed', t0) >= 1) { firstTurnDone = true; break; }
    }
    rec.firstTurnDone = firstTurnDone;
    rec.preInject = {
      goal: (await c.rpc('thread/goal/get', { threadId })).result?.goal,
      turnStartedCount: countSince('turn/started', t0),
      turnCompletedCount: countSince('turn/completed', t0),
      outTxtExists: existsSync(join(work, 'out.txt')),
    };

    const tInject = Date.now();
    // 实测发现（trial candA 第一次跑撞出来的）：正确方法名是 thread/inject_items（下划线），
    // 不是 brief 写的 thread/inject-items（连字符）——app-server 对未知 method 返回 -32600，
    // 错误信息完整枚举了全部合法 method 名，里面确认只有 `thread/inject_items` 这个下划线变体。
    const injectResp = await c.rpc('thread/inject_items', { threadId, items });
    rec.inject = injectResp.result ?? injectResp.error;
    rec.injectError = !!injectResp.error;
    console.log(`[${label}] inject error?`, rec.injectError, JSON.stringify(rec.inject));

    // 观察窗 45s（按 brief），轮询记录 out.txt 首次出现的相对时间，而不是纯 sleep 到底再看一眼。
    // rpc 层面已经 error（method 名错/参数错）时跳过观察窗——请求根本没被接受，没有东西会被注入，
    // 继续等 45s 只会白烧 goal 自动续轮的真实 API token，不会产生任何新证据。
    let outTxtAppearedAt = null;
    if (!rec.injectError) {
      for (let i = 0; i < 9; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        if (!outTxtAppearedAt && existsSync(join(work, 'out.txt'))) outTxtAppearedAt = Date.now() - tInject;
      }
    }

    rec.getFinal = (await c.rpc('thread/goal/get', { threadId })).result?.goal;
    rec.eventsAfterInject = [...new Set(events.filter((e) => e.t >= tInject).map((e) => e.method))];
    rec.turnStartedAfterInject = countSince('turn/started', tInject);
    rec.turnCompletedAfterInject = countSince('turn/completed', tInject);
    rec.outTxtExistsFinal = existsSync(join(work, 'out.txt'));
    rec.outTxtContent = rec.outTxtExistsFinal ? readFileSync(join(work, 'out.txt'), 'utf8') : null;
    rec.outTxtAppearedAtMsAfterInject = outTxtAppearedAt;
    rec.tokensUsedDelta = (rec.getFinal?.tokensUsed ?? 0) - (rec.preInject.goal?.tokensUsed ?? 0);

    // PASS 判据用最强证据：out.txt 真的按 DIAGNOSTIC 的要求创建（DIAGNOSTIC 是唯一提过 out.txt/DONE
    // 的输入源）。不单靠 turnStarted 计数增长——S2 已证实 goal active 且目标未达成时本就会自动续轮，
    // 续轮计数增长不能单独归因于 inject。
    rec.pass = !rec.injectError && rec.outTxtExistsFinal && /DONE/i.test(rec.outTxtContent ?? '');
    console.log(`[${label}] pass=${rec.pass} outTxtContent=${JSON.stringify(rec.outTxtContent)} tokensUsedDelta=${rec.tokensUsedDelta} turnStartedAfterInject=${rec.turnStartedAfterInject}`);
  } finally {
    cleanup();
    process.off('SIGTERM', onSignal);
    process.off('SIGINT', onSignal);
  }
  return rec;
}

const rec = { diagnostic: DIAGNOSTIC, objective: OBJECTIVE, trials: [] };
try {
  // Step 1 实测：ThreadInjectItemsParams.items 是 "Raw Responses API items"（schema 里 items:true，
  // 无内部结构约束）。Candidate A 是 brief 给的猜测形状（{type:'text',text}——这其实是 UserInput 的
  // 形状，用在 turn/start.input，不是 Responses API item）。Candidate B 是从同一份 schema 目录
  // RawResponseItemCompletedNotification.json 的 ResponseItem.MessageResponseItem 定义反查出的真实
  // Responses API message item 形状（{type:'message', role, content:[{type:'input_text', text}]}）。
  // 两个都实测，而不是只信 brief 的猜测。
  const candidateA = { type: 'text', text: DIAGNOSTIC };
  const trialA = await runTrial('candA', [candidateA]);
  rec.trials.push(trialA);

  let trialB = null;
  if (!trialA.pass) {
    const candidateB = { type: 'message', role: 'user', content: [{ type: 'input_text', text: DIAGNOSTIC }] };
    trialB = await runTrial('candB', [candidateB]);
    rec.trials.push(trialB);
  }

  const winning = [trialA, trialB].find((t) => t?.pass);
  rec.pass = !!winning;
  rec.winningShape = winning ? winning.items[0] : null;
} finally {
  writeFileSync(join(process.env.REPO_FIX ?? '.', 's4-inject.json'), JSON.stringify(rec, null, 2));
  console.log('=== S4 SUMMARY ===');
  console.log('pass=', rec.pass, 'winningShape=', JSON.stringify(rec.winningShape));
  for (const t of rec.trials) {
    console.log(`  trial[${t.label}]: injectError=${t.injectError} outTxtExistsFinal=${t.outTxtExistsFinal} outTxtContent=${JSON.stringify(t.outTxtContent)}`);
  }
}
