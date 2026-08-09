import { writeHookSettings } from './lib/claude-probe.mjs';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const scratch = mkdtempSync(join(tmpdir(), 'spike-s3-'));
const sentinel = join(scratch, 'DONE.sentinel');
const { settingsPath, logPath } = writeHookSettings({ dir: scratch, sentinelPath: sentinel });
const rec = { scratch };

function hookRunCount() {
  return existsSync(logPath) ? readFileSync(logPath, 'utf8').trim().split('\n').length : 0;
}

function runClaude(args) {
  try { return { out: execFileSync('claude', args, { cwd: scratch, encoding: 'utf8', timeout: 180000 }) }; }
  catch (e) { return { err: String(e), out: e.stdout?.toString?.() ?? '' }; }
}

try {
  // --- Run A：block 驱动续轮测试 ---
  // 首轮原样跑 brief 的直白 prompt（明说"创建 sentinel"）时，模型一步到位，hook 只触发一次 allow，
  // 看不出 block 是否真的能强制续轮。改用「先做件无关小事就想停、完全不提 sentinel」的 prompt，
  // 逼模型第一次尝试停止时空手而归，block 只能靠 hook 的 reason 文本驱动它回头创建 sentinel。
  // 注：曾用过一版显式加「不要创建任何文件」的禁止性 prompt——那会让模型把用户指令的优先级
  // 判断得高于 hook reason，全程拒绝执行导致 8 轮全部 block 到 max_turns 耗尽（详见报告附录）。
  // 这里去掉禁止性指令，只是不提 sentinel，避免引入这个指令冲突混淆变量。
  const promptA = 'Print the current date using a shell command, then stop.';
  const rA = runClaude(['-p', promptA, '--output-format', 'json', '--settings', settingsPath,
    '--permission-mode', 'acceptEdits', '--max-turns', '8']);
  rec.runA = {
    out: rA.out?.slice?.(0, 4000), err: rA.err,
    sentinelCreated: existsSync(sentinel),
    hookRunsAfter: hookRunCount(),
  };
  let sidA; try { sidA = JSON.parse(rA.out).session_id; } catch {}
  rec.runA.sessionId = sidA;
  rec.blockDrovesContinuation = rec.runA.hookRunsAfter >= 2 && rec.runA.sentinelCreated;

  // --- Run B：resume + --settings，删掉 sentinel，看 hook 是否随 resume 继承触发 ---
  if (sidA) {
    rmSync(sentinel, { force: true });
    const before = hookRunCount();
    const rB = runClaude(['-p', 'continue', '--resume', sidA, '--output-format', 'json',
      '--settings', settingsPath, '--permission-mode', 'acceptEdits', '--max-turns', '8']);
    rec.runB = {
      out: rB.out?.slice?.(0, 4000), err: rB.err,
      hookRunsBefore: before, hookRunsAfter: hookRunCount(),
      sentinelCreated: existsSync(sentinel),
    };
    rec.runB.hookRanOnResume = rec.runB.hookRunsAfter > before;
  }

  // --- Run C：resume 但不带 --settings，看 hook 是否消失（对照组） ---
  if (sidA) {
    rmSync(sentinel, { force: true });
    const before = hookRunCount();
    const rC = runClaude(['-p', 'continue', '--resume', sidA, '--output-format', 'json',
      '--permission-mode', 'acceptEdits', '--max-turns', '8']); // 故意不传 --settings
    rec.runC = {
      out: rC.out?.slice?.(0, 4000), err: rC.err,
      hookRunsBefore: before, hookRunsAfter: hookRunCount(),
      sentinelCreated: existsSync(sentinel),
    };
    rec.runC.hookRanWithoutSettings = rec.runC.hookRunsAfter > before;
  }

  rec.totalHookRuns = hookRunCount();
} finally {
  writeFileSync(join(process.env.REPO_FIX ?? '.', 's3-hook-loop.json'), JSON.stringify(rec, null, 2));
  console.log('blockDrovesContinuation=', rec.blockDrovesContinuation);
  console.log('runA.sentinelCreated=', rec.runA?.sentinelCreated, 'runA.hookRunsAfter=', rec.runA?.hookRunsAfter);
  console.log('runB.hookRanOnResume(with --settings)=', rec.runB?.hookRanOnResume);
  console.log('runC.hookRanWithoutSettings(no --settings)=', rec.runC?.hookRanWithoutSettings);
}
