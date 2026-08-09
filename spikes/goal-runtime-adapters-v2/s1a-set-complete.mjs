import { AppServerClient } from './lib/appserver-client.mjs';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'spike-s1a-'));
const codexHome = join(scratch, 'codex-home'); mkdirSync(codexHome, { recursive: true });
const c = new AppServerClient({ mode: 'stdio', codexHome, cwd: scratch });
await c.start(); await c.initialize();
// 实测发现:ephemeral thread 拒绝 goal RPC(-32600 "ephemeral thread does not support goals")。
// goal 生命周期绑定非 ephemeral(持久化)thread;codexHome 仍是临时目录,不破隔离铁律。
const { threadId } = await c.threadStart({ ephemeral: false });

const rec = { threadId };
try {
  rec.setActive = await c.rpc('thread/goal/set', { threadId, objective: 'Write DONE into ./out.txt then stop.', tokenBudget: 50000 });
  rec.setComplete = await c.rpc('thread/goal/set', { threadId, status: 'complete' });
  rec.getAfter = await c.rpc('thread/goal/get', { threadId });
  // 关键核查:envelope 是否含 goal_id
  const goal = rec.setComplete?.result?.goal ?? {};
  rec.goalKeys = Object.keys(goal);
  rec.hasGoalId = 'goalId' in goal || 'goal_id' in goal;
  rec.statusAfterComplete = rec.getAfter?.result?.goal?.status;
} finally {
  writeFileSync(join(process.env.REPO_FIX ?? '.', 's1a.json'), JSON.stringify(rec, null, 2));
  console.log('goalKeys=', JSON.stringify(rec.goalKeys));
  console.log('hasGoalId=', rec.hasGoalId, 'statusAfterComplete=', rec.statusAfterComplete);
  await c.stop();
}
