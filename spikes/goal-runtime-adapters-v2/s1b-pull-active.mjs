import { AppServerClient } from './lib/appserver-client.mjs';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const RUN_COUNT = 3; // review fix: 复现性声明要能从 fixture 自证，落 3 次独立跑而非只跑 1 次贴口述

async function runOnce(runIndex) {
  const scratch = mkdtempSync(join(tmpdir(), 'spike-s1b-'));
  const codexHome = join(scratch, 'codex-home'); mkdirSync(codexHome, { recursive: true });
  const c = new AppServerClient({ mode: 'stdio', codexHome, cwd: scratch });
  await c.start(); await c.initialize();
  const { threadId } = await c.threadStart({ ephemeral: false });   // goal 必须挂非 ephemeral thread（S1a 实测 -32600）
  const cases = [];

  async function setGet(label, params) {
    const set = await c.rpc('thread/goal/set', { threadId, ...params });
    const get = await c.rpc('thread/goal/get', { threadId });
    // review fix: 除 status 外多取 tokensUsed——CASE 闸的守卫是 tokens_used >= token_budget，
    // 不落这个字段，"守卫恒假故未触发"这个判读前提就只能靠跨任务推断，不能从本次 fixture 自证。
    const row = {
      label, requested: params,
      setStatus: set?.result?.goal?.status, setTokensUsed: set?.result?.goal?.tokensUsed,
      getStatus: get?.result?.goal?.status, getTokensUsed: get?.result?.goal?.tokensUsed,
      error: set?.error,
    };
    cases.push(row);
    console.log(`[run ${runIndex}]`, label, '→ requested', params.status ?? '(objective)',
      '| get.status=', row.getStatus, '| get.tokensUsed=', row.getTokensUsed, '| err=', !!row.error);
    return row;
  }

  try {
    await setGet('create', { objective: 'Write DONE into ./out.txt then stop.', tokenBudget: 50000 });
    await setGet('to-complete', { status: 'complete' });
    await setGet('pull-active-plain', { status: 'active' });               // 会不会被粘滞吞？
    await setGet('to-budget', { status: 'budgetLimited' });                // 若不允许外部直设，记录 error
    await setGet('pull-active-with-budget', { status: 'active', tokenBudget: 1000000 }); // 带预算变体
  } finally {
    await c.stop();
  }
  return { threadId, cases };
}

const runs = [];
for (let i = 0; i < RUN_COUNT; i++) {
  runs.push(await runOnce(i));
}
writeFileSync(join(process.env.REPO_FIX ?? '.', 's1b.json'), JSON.stringify({ runs }, null, 2));
