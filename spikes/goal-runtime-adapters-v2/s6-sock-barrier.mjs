import { spawn } from 'node:child_process';
import net from 'node:net';
import { mkdtempSync, writeFileSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

// S6：goalRpc controller 独占是纯纪律还是有物理壁垒——决定 finalize receipt 可信 or 降 audit_only。
//
// 前置探测发现（Step 1 实测坐实，非猜测）：某些安装形态下 `codex` 只是桌面应用内置二进制的软链
// （本次实测环境即如此：`~/.local/bin/codex` -> 桌面应用 Resources 目录下的 codex），不是
// `curl -fsSL https://chatgpt.com/codex/install.sh | sh` 装的"受管 standalone install"。
// `codex app-server daemon start` 硬性要求 $CODEX_HOME/packages/standalone/current/codex 这个受管
// 安装清单——不管 CODEX_HOME 是隔离的临时目录还是生产 ~/.codex（两者都验证过、两者都没有这个清单，
// 生产 ~/.codex 下甚至没有 app-server-daemon/ 目录，说明 ChatGPT 桌面应用走的是完全不同的内部 IPC
// 机制，不经过这套 daemon 子系统）。这台机器上也没有第二份 standalone 安装可切换。装一份新的
// standalone 版本会永久改变系统状态（新装二进制、可能改 PATH 优先级），超出本次 spike 的可逆范围，
// 未经明确授权不做。
//
// 替代方案（有明确依据，非随意绕过）：`codex app-server --help` 里 `--listen` 支持 `unix://PATH`
// 直连（不经 daemon 的自管理/自更新包装）。这是同一个 app-server 二进制、同一套 RPC 协议、同一种
// Unix socket 监听机制——sandbox 是否放行 connect() 这件事只取决于"调用方进程的 seatbelt profile
// 是否允许连到这个文件系统路径"，跟监听端是被 daemon 管理还是我们自己前台启动的无关（seatbelt 管的
// 是调用方的语法权限，不看对端进程身份）。因此用 `--listen unix://<path>` 自己起、自己管生命周期，
// 是对"sock 访问壁垒"这个问题的忠实替代，只是我们自己当 daemon 的进程管理者（用 SIGTERM 停，
// 不调用 `daemon stop`）。

const SCRIPT_DIR = new URL('.', import.meta.url).pathname;
const FIX_DIR = process.env.REPO_FIX ? process.env.REPO_FIX : join(SCRIPT_DIR, 'fixtures');
const FIX_PATH = join(FIX_DIR, 's6-sock-barrier.json');

function tryConnect(path, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const s = net.createConnection(path);
    s.once('connect', () => { s.destroy(); resolve({ connected: true }); });
    s.once('error', (e) => resolve({ connected: false, code: e.code }));
    setTimeout(() => { s.destroy(); resolve({ connected: false, code: 'TIMEOUT' }); }, timeoutMs);
  });
}

function runCapture(cmd, args, opts = {}, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { p.kill('SIGKILL'); }, timeoutMs);
    p.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

const rec = {
  step1_daemonStartAttempt: null,
  step1_substitute: null,
  sock: null,
  controllerView: null, // 视角 A
  executorView: null,   // 视角 B
  verdict: null,
};

let appsrvProc = null;
let daemonAttemptCodexHome = null;
let substrateCodexHome = null;
let sockDir = null;
let execCodexHome = null;
let execWork = null;
let cleaned = false;

function cleanup() {
  if (cleaned) return;
  cleaned = true;
  if (appsrvProc && !appsrvProc.killed) {
    try { appsrvProc.kill('SIGTERM'); } catch { /* best-effort */ }
  }
  for (const d of [daemonAttemptCodexHome, substrateCodexHome, sockDir, execCodexHome, execWork]) {
    if (d) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ } }
  }
  console.log('cleaned up temp dirs + substitute app-server process');
}
const onSignal = (sig) => {
  console.error(`received ${sig} — cleaning up before exit`);
  cleanup();
  process.exit(1);
};
process.on('SIGTERM', onSignal);
process.on('SIGINT', onSignal);

try {
  // ---- Step 1a：如实复现 daemon start 的硬性阻断（落盘证据，不只是口头转述）----
  daemonAttemptCodexHome = mkdtempSync(join(tmpdir(), 'spike-s6-daemon-attempt-'));
  const startAttempt = await runCapture('codex', ['app-server', 'daemon', 'start'],
    { env: { ...process.env, CODEX_HOME: daemonAttemptCodexHome } }, 20000);
  rec.step1_daemonStartAttempt = {
    codexHome: daemonAttemptCodexHome,
    exitCode: startAttempt.code,
    stdout: startAttempt.stdout.trim(),
    stderr: startAttempt.stderr.trim(),
    blocked: startAttempt.code !== 0,
  };
  console.log('[step1] daemon start blocked?', rec.step1_daemonStartAttempt.blocked, '—', rec.step1_daemonStartAttempt.stderr.split('\n')[0]);

  // ---- Step 1b：替代——自己前台起 app-server，--listen unix://<短路径> ----
  // sock 路径必须短（macOS AF_UNIX sun_path 有长度上限，实测 mktemp -d 默认深路径会撞
  // "path must be shorter than SUN_LEN"），用字面 /tmp 下的短前缀，且不能直接落在 /tmp 根
  // （实测直接用 unix:///tmp/x.sock 会报 "socket directory path exists and is not a directory:
  // /tmp"，深一层子目录即可）。
  sockDir = mkdtempSync('/tmp/s6-sock-');
  const sockPath = join(sockDir, 'a.sock');
  substrateCodexHome = mkdtempSync(join(tmpdir(), 'spike-s6-appsrv-codex-home-'));

  appsrvProc = spawn('codex', ['app-server', '--listen', `unix://${sockPath}`],
    { env: { ...process.env, CODEX_HOME: substrateCodexHome }, stdio: ['ignore', 'pipe', 'pipe'] });
  let appsrvOut = '', appsrvErr = '';
  appsrvProc.stdout.on('data', (d) => { appsrvOut += d; });
  appsrvProc.stderr.on('data', (d) => { appsrvErr += d; });
  let appsrvExited = false;
  appsrvProc.on('exit', (code) => { appsrvExited = true; appsrvErr += `\n[exited early with code ${code}]`; });

  // 轮询等 sock 文件出现，而不是固定 sleep（更快、也更能反映真实就绪时机）
  let sockReady = false;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (existsSync(sockPath)) { sockReady = true; break; }
    if (appsrvExited) break;
  }
  rec.step1_substitute = {
    sockDir, sockPath, substrateCodexHome,
    pid: appsrvProc.pid, sockReady, appsrvExitedEarly: appsrvExited,
    appsrvStdout: appsrvOut.trim(), appsrvStderr: appsrvErr.trim(),
  };
  rec.sock = sockPath;
  console.log('[step1b] substitute app-server sockReady=', sockReady, 'pid=', appsrvProc.pid);
  if (!sockReady) throw new Error('substitute app-server never created sock file — cannot proceed to Step 3/4');

  // ---- Step 3：视角 A，控制器直连 ----
  rec.controllerView = await tryConnect(sockPath);
  console.log('controllerView:', JSON.stringify(rec.controllerView));

  // ---- Step 4：视角 B，codex exec --sandbox workspace-write 内连同一 sock ----
  execCodexHome = mkdtempSync(join(tmpdir(), 'spike-s6-exec-codex-home-'));
  execWork = mkdtempSync(join(tmpdir(), 'spike-s6-exec-work-'));
  const authSrc = join(homedir(), '.codex', 'auth.json');
  let authCopied = false;
  if (existsSync(authSrc)) { copyFileSync(authSrc, join(execCodexHome, 'auth.json')); authCopied = true; }
  // execCodexHome 与 execWork 各自独立 mkdtempSync，不共享父目录（S4/S2 已验证的隔离模式：
  // workspace-write sandbox 只限写不限读，避免执行体用相对路径读到凭证副本）。

  const nodeOneLiner = `const net=require('net');const s=net.createConnection(${JSON.stringify(sockPath)});`
    + `s.on('connect',()=>{console.log('EXECUTOR_CONNECTED');s.destroy();process.exit(0)});`
    + `s.on('error',e=>{console.log('EXECUTOR_BLOCKED:'+e.code);process.exit(0)});`
    + `setTimeout(()=>{console.log('EXECUTOR_BLOCKED:TIMEOUT');process.exit(0)},4000);`;
  const prompt = `Run this exact shell command and then stop: node -e ${JSON.stringify(nodeOneLiner)}\n`
    + `Report the command's stdout verbatim in your final message. Do not modify the command. Do not create any files.`;

  console.log('[step4] launching codex exec --sandbox workspace-write (may take a while, API side has been unstable)...');
  const execResult = await runCapture('codex',
    ['exec', '--sandbox', 'workspace-write', '-C', execWork, '--skip-git-repo-check', '--ephemeral', prompt],
    { env: { ...process.env, CODEX_HOME: execCodexHome } },
    150000); // 150s：留够真实 turn + 可能的 API 端 Overloaded 重试余量，但不无限等
  const combined = execResult.stdout + '\n' + execResult.stderr;
  const marker = /EXECUTOR_CONNECTED|EXECUTOR_BLOCKED:\S+/.exec(combined);
  rec.executorView = {
    authCopied, execCodexHome, execWork,
    exitCode: execResult.code,
    marker: marker ? marker[0] : null,
    connected: marker ? marker[0] === 'EXECUTOR_CONNECTED' : null,
    stdoutTail: execResult.stdout.slice(-4000),
    stderrTail: execResult.stderr.slice(-2000),
  };
  console.log('[step4] marker found:', rec.executorView.marker ?? 'NO_MARKER（判读见 stdoutTail/stderrTail）');

  // ---- Step 5：判定 ----
  if (rec.executorView.marker === 'EXECUTOR_CONNECTED') {
    rec.verdict = 'CONNECTED → sock 访问壁垒不存在 → finalize receipt 降 audit_only';
  } else if (rec.executorView.marker && rec.executorView.marker.startsWith('EXECUTOR_BLOCKED')) {
    rec.verdict = 'BLOCKED → sock 访问壁垒成立（在本替代实验的前提下）→ finalize receipt 维持可信，但注意本测试用的是 --listen unix:// 前台替代进程，不是 daemon 管理的真实 control sock（daemon 子系统在本机无法起——见 step1_daemonStartAttempt），结论的可信度受此限制';
  } else {
    rec.verdict = 'NO_MARKER — 未拿到明确判读（可能是 codex exec 本身失败/超时/被拒绝执行，非 sock 层面的信号），见 executorView.stdoutTail/stderrTail 人工判读';
  }
  console.log('=== S6 VERDICT ===', rec.verdict);
} finally {
  cleanup();
  process.off('SIGTERM', onSignal);
  process.off('SIGINT', onSignal);
  writeFileSync(FIX_PATH, JSON.stringify(rec, null, 2));
  console.log('fixture written to', FIX_PATH);
}
