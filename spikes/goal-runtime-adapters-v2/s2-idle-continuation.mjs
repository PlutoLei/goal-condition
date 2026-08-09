import { AppServerClient } from './lib/appserver-client.mjs';
import { mkdtempSync, writeFileSync, copyFileSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

// codexHome 与 work 各自独立 mkdtempSync，不共享父目录（review fix：原来是 scratch/codex-home +
// scratch/work 两个兄弟目录，workspace-write sandbox 只限写不限读，正在执行 objective 的 AI 执行体
// 理论上能从 work 用相对路径 ../codex-home/auth.json 读到里面的凭证副本）。两个路径互相不可猜测的
// 独立 mkdtempSync 目录，让 codexHome 物理上与 work 分离。
const codexHome = mkdtempSync(join(tmpdir(), 'spike-s2-codex-home-'));
const work = mkdtempSync(join(tmpdir(), 'spike-s2-work-'));
// 真实 turn 需要认证；隔离 CODEX_HOME 默认没有 auth.json（预探测实测：无 auth 时 turn/start 后台反复
// 401 Unauthorized 重连，goal 状态机永远看不到真实 token 消耗）。只读复制生产 auth.json（OAuth token），
// 不碰 goals_1.sqlite / config.toml / 其余生产状态——隔离铁律保护的是状态库，不是认证凭证本身。
const authSrc = join(homedir(), '.codex', 'auth.json');
if (existsSync(authSrc)) copyFileSync(authSrc, join(codexHome, 'auth.json'));

const c = new AppServerClient({ mode: 'stdio', codexHome, cwd: work });
await c.start(); await c.initialize();
const { threadId } = await c.threadStart({ ephemeral: false, sandbox: 'workspace-write', cwd: work });   // goal 必须挂非 ephemeral thread（S1a 实测 -32600）

const events = [];
c.onNotification((n) => { events.push({ t: Date.now(), method: n.method }); });

const objective = 'Step 1: create ./a.txt containing X. Then in a later turn, Step 2: create ./b.txt containing Y. '
  + 'Do them in separate turns: after finishing step 1, end your turn and stop — do not start step 2 yourself in this same turn.';

const rec = { threadId, objective };
try {
  rec.set = (await c.rpc('thread/goal/set', { threadId, objective, tokenBudget: 50000 })).result;
  // 起首轮 method（本 task 头号前置，已实测确认）：goal/set 不触发执行；`turn/start`
  // （TurnStartParams: {threadId, input:[UserInput]}）才真的把 goal 推入执行——探测脚本里
  // 用同样的调用跑通过一次完整 turn（item/started → fileChange → turn/completed，tokensUsed 从 0 真实增长）。
  // 本脚本只调用这一次 turn/start，之后 90s 全程被动订阅通知——这正是要测的问题：
  // 「不再手动调用的情况下，goal 仍 active 时，服务端会不会自己再起第二个 turn」。
  rec.turnStart = (await c.rpc('turn/start', { threadId, input: [{ type: 'text', text: objective }] })).result;
  // 观察窗
  await new Promise((r) => setTimeout(r, 90000));
  rec.getFinal = (await c.rpc('thread/goal/get', { threadId })).result;
  rec.events = events;
  rec.turnStartedCount = events.filter((e) => e.method === 'turn/started').length;
  rec.turnCompletedCount = events.filter((e) => e.method === 'turn/completed').length;
  rec.goalUpdates = events.filter((e) => e.method === 'thread/goal/updated').length;
  rec.turnStarts = rec.turnStartedCount; // 兼容 brief 判读字段名
  // 落盘前拍一份 work 目录快照——codexHome/work 跑完即删（见 finally），这是清理前唯一能证明
  // 「两个文件在不同时间点被真实创建」的机会，不能只信一句口述。
  rec.workFiles = readdirSync(work).map((name) => ({ name, mtimeMs: statSync(join(work, name)).mtimeMs }));
} finally {
  writeFileSync(join(process.env.REPO_FIX ?? '.', 's2-idle-continuation.json'), JSON.stringify(rec, null, 2));
  console.log('distinct notify methods:', [...new Set(events.map((e) => e.method))]);
  console.log('turnStartedCount~', rec.turnStartedCount, 'turnCompletedCount=', rec.turnCompletedCount, 'goalUpdates=', rec.goalUpdates);
  console.log('final goal:', JSON.stringify(rec.getFinal));
  console.log('workFiles:', JSON.stringify(rec.workFiles));
  await c.stop();
  // 凭证清理（review Important）：codexHome 里有生产 auth.json 的只读副本，跑完必须主动删掉，
  // 不能指望 macOS 对 /var/folders 临时目录的清理时机——那不可靠，可能长期不清。
  rmSync(codexHome, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
  console.log('cleaned up:', codexHome, work);
}
