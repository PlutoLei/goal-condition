import { AppServerClient } from './lib/appserver-client.mjs';
import { mkdtempSync, writeFileSync, copyFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

// codexHome 与 work 各自独立 mkdtempSync，不共享父目录（同 S2 的 review fix：避免 work 里执行的
// AI 执行体用 ../codex-home/auth.json 这种相对路径读到凭证副本——workspace-write sandbox 只限写不限读）。
const codexHome = mkdtempSync(join(tmpdir(), 'spike-s2b-codex-home-'));
const work = mkdtempSync(join(tmpdir(), 'spike-s2b-work-'));
// 同 S2：真实 turn 需要认证，只读复制生产 auth.json，不碰 goals_1.sqlite/config.toml/其余生产状态。
const authSrc = join(homedir(), '.codex', 'auth.json');
if (existsSync(authSrc)) copyFileSync(authSrc, join(codexHome, 'auth.json'));

const c = new AppServerClient({ mode: 'stdio', codexHome, cwd: work });
await c.start(); await c.initialize();
const { threadId } = await c.threadStart({ ephemeral: false, sandbox: 'workspace-write', cwd: work });
const rec = { threadId, phases: [] };
function snap(label, goal) {
  const row = { label, status: goal?.status, tokensUsed: goal?.tokensUsed, tokenBudget: goal?.tokenBudget };
  rec.phases.push(row); console.log(label, JSON.stringify(row)); return row;
}
try {
  // 小预算逼超；objective 是持续烧 token 的多轮任务
  const objective = 'Repeatedly append one timestamped line to ./log.txt, one line per turn, and keep going every turn.';
  const set = await c.rpc('thread/goal/set', { threadId, objective, tokenBudget: 2000 });
  snap('set', set.result?.goal);
  // 起首轮：S2 实测确认的 method 是 turn/start（{threadId, input:[{type:'text',text}]}）。S2 的探测同时表明
  // 单轮固定开销（system prompt + tool 声明等）就有 8000+ tokens 量级，远超本次刻意调小的 2000 预算——
  // 且 S2 已证实服务端会在 goal active 时自动链式续轮，所以这里只需起一次首轮，不必手动循环调用 turn/start。
  const turnStart = await c.rpc('turn/start', { threadId, input: [{ type: 'text', text: objective }] });
  rec.turnStartRaw = turnStart.result ?? turnStart.error;
  console.log('turn/start ->', JSON.stringify(rec.turnStartRaw));
  // 轮询等 budgetLimited（小预算应几轮内触发）
  let hitBudget = null;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 6000));
    const g = await c.rpc('thread/goal/get', { threadId });
    const row = snap(`poll-${i}`, g.result?.goal);
    if (row.status === 'budgetLimited') { hitBudget = row; break; }
    if (row.status === 'complete') break;
  }
  rec.reachedBudgetLimited = !!hitBudget;
  if (hitBudget) {
    // 拉回①：set active 不抬预算 → 应被吞回 budgetLimited（坐实 readback 必要性）
    const p1 = await c.rpc('thread/goal/set', { threadId, status: 'active' });
    snap('pull-no-raise(set)', p1.result?.goal);
    const g1 = await c.rpc('thread/goal/get', { threadId });
    const r1 = snap('pull-no-raise(readback)', g1.result?.goal);
    rec.swallowedWithoutRaise = r1.status !== 'active';
    // 拉回②：set active + 抬预算 → 应停在 active（坐实 spec §4 应对）
    const p2 = await c.rpc('thread/goal/set', { threadId, status: 'active', tokenBudget: (hitBudget.tokensUsed ?? 2000) + 50000 });
    snap('pull-with-raise(set)', p2.result?.goal);
    const g2 = await c.rpc('thread/goal/get', { threadId });
    const r2 = snap('pull-with-raise(readback)', g2.result?.goal);
    rec.recoveredWithRaise = r2.status === 'active';
    // 抬预算拉回后，goal active 且服务端可能再自动续轮（S2 已证实的链式行为）；等几秒看是否会
    // 再次被烧穿——若立刻又转 budgetLimited，说明"抬预算"给的余量在单轮固定开销面前形同虚设。
    await new Promise((r) => setTimeout(r, 8000));
    const g3 = await c.rpc('thread/goal/get', { threadId });
    snap('post-recover-settle', g3.result?.goal);
  }
  // 落盘前拍一份 log.txt 内容——codexHome/work 跑完即删（见 finally），这是清理前唯一能核实
  // "objective 真的在追加内容"的机会。
  rec.logContent = existsSync(join(work, 'log.txt')) ? readFileSync(join(work, 'log.txt'), 'utf8') : null;
} finally {
  writeFileSync(join(process.env.REPO_FIX ?? '.', 's2b-budget-recovery.json'), JSON.stringify(rec, null, 2));
  console.log('reachedBudgetLimited=', rec.reachedBudgetLimited, 'swallowed(no raise)=', rec.swallowedWithoutRaise, 'recovered(with raise)=', rec.recoveredWithRaise);
  console.log('logContent:', JSON.stringify(rec.logContent));
  await c.stop();
  // 凭证清理（review Important）：同 S2，codexHome 里的生产 auth.json 只读副本跑完必须主动删掉。
  rmSync(codexHome, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
  console.log('cleaned up:', codexHome, work);
}
