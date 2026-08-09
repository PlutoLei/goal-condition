import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// fix round 1（review Important #1）自测：只验证"SIGTERM/SIGINT 时 cleanup() 仍会跑"这条信号
// 兜底逻辑本身——不起 codex app-server、不用真实 auth.json（写个占位文件即可）、不消耗任何真实
// API。测的是 s4-inject.mjs runTrial() 里同一套 cleanup()/process.on(SIGTERM/SIGINT) 模式，
// 抽出来单独跑。故意用外部 kill（而不是脚本自己 process.kill(process.pid,...)）——这才是本轮
// 真实事故的场景（我在另一个 shell 里手动 kill -TERM 跑飞的进程），也避开了同进程自发信号在
// Node/libuv 里可能出现的时序竞态（第一版自测用 setTimeout 内自发信号，process.on 的 handler
// 从未被观测到触发，process 以 exit code 0 自然退出——这本身就是一个值得记录的对照失败案例，
// 不是清理逻辑的 bug，是自测手法的 bug，已改用更贴近真实场景的外部 kill）。
const codexHome = mkdtempSync(join(tmpdir(), 'spike-s4-selftest-codex-home-'));
const work = mkdtempSync(join(tmpdir(), 'spike-s4-selftest-work-'));
writeFileSync(join(codexHome, 'auth.json'), '{"placeholder":"not a real credential"}');

let cleaned = false;
const cleanup = () => {
  if (cleaned) return;
  cleaned = true;
  rmSync(codexHome, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
};
const onSignal = (sig) => { console.log(`received ${sig}`); cleanup(); process.exit(1); };
process.on('SIGTERM', onSignal);
process.on('SIGINT', onSignal);

console.log('PID', process.pid);
console.log('codexHome', codexHome, 'exists?', existsSync(codexHome));
console.log('work', work, 'exists?', existsSync(work));
console.log('READY'); // 外部脚本轮询看到这行再发 kill，避免在目录/handler 还没就绪时就杀

// 保持进程存活，等外部 kill；不设超时上限——外部驱动脚本负责发信号和判超时。
setInterval(() => {}, 60000);
