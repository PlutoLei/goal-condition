// Thin CLI dispatcher. Runtime attempt lifecycles live under scripts/lib/runners/.
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { contractHash, readContract, renderContractDiagnostic } from './lib/contract.mjs';
import {
  canonicalPath, compileResumeDiagnostic, DIAGNOSTICS_SHAPE, RESUMABLE_CODES, stateDirFor,
} from './lib/runner-common.mjs';
import {
  prepareClaude, runClaudeAttempt, runClaudeReadback,
} from './lib/runners/claude.mjs';
import {
  prepareCodexProbesOnly, runCodexClose, runCodexFinalize, runCodexLaunch, runCodexResume,
} from './lib/runners/codex.mjs';

// Preserve the historical library surface while ownership follows the implementation module.
export * from './lib/runner-common.mjs';
export * from './lib/claude-capability.mjs';
export * from './lib/runners/claude.mjs';
export * from './lib/runners/codex.mjs';

const COMMANDS = {
  prepare: {
    allowed: ['--contract', '--state-root', '--controller'],
    required: ['--contract', '--state-root'],
  },
  launch: {
    allowed: ['--contract', '--state', '--prompt-file', '--binding-file'],
    required: ['--contract', '--state', '--prompt-file', '--binding-file'],
  },
  resume: {
    allowed: ['--contract', '--state', '--diagnostics-file', '--binding-file', '--raise-token-budget'],
    required: ['--contract', '--state', '--diagnostics-file', '--binding-file'],
  },
  finalize: { allowed: ['--state', '--binding-file'], required: ['--state', '--binding-file'] },
  close: { allowed: ['--state'], required: ['--state'] },
  readback: { allowed: ['--state'], required: ['--state'] },
};

function usage() {
  return [
    'Usage:',
    '  node scripts/launch.mjs prepare --contract FILE --state-root PATH [--controller NAME]',
    '  node scripts/launch.mjs launch --contract FILE --state DIR --prompt-file FILE --binding-file FILE',
    '  node scripts/launch.mjs resume --contract FILE --state DIR --diagnostics-file FILE --binding-file FILE [--raise-token-budget N]',
    '  node scripts/launch.mjs finalize --state DIR --binding-file FILE',
    '  node scripts/launch.mjs close --state DIR',
    '  node scripts/launch.mjs readback --state DIR',
    '',
    'readback 是 claude 线的只读观测（transcript 活性、prompt 归因），恒 exit 0：available:false',
    '表示观测不可用，不代表 run 出事；它的结论不进任何证据通道，处置留给人工。',
    '',
    '--raise-token-budget 只在 codex 续跑时可用，且只有显式写出来才会抬预算：预算仅用户明给，',
    '这个 flag 就是那份用户确认的载体，缺省绝不自动抬。',
    '',
    '--diagnostics-file 收的是一份红项清单，不是自由文本——注入给执行体的那段话由本脚本按 contract',
    `渲染，编排器只声明「哪几条红了、退出码多少」：${DIAGNOSTICS_SHAPE}`,
    'entry 必须是本 contract 的 postflight 条目 id（命令与 cwd 从 contract 取，不从这个文件读），',
    `code 只认可续类 ${RESUMABLE_CODES.join(' / ')}。执行体产出的字节一律不得进入这个通道。`,
  ].join('\n');
}

export function parseArgs(argv) {
  const command = argv[0];
  const spec = COMMANDS[command];
  if (!spec) throw new Error(usage());
  const values = {};
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined || !spec.allowed.includes(flag) || values[flag] !== undefined) {
      throw new Error(usage());
    }
    values[flag] = value;
  }
  for (const flag of spec.required) {
    if (!values[flag]) throw new Error(usage());
  }
  return { command, values };
}

// binding 文件缺失或 JSON 损坏都归一为 undefined——runClaudeAttempt 自己的三方交叉判定会
// 统一 fail-closed（未定义的 contractHash 永远对不上 stateDir 末段），不重复这段判定逻辑。
async function readBindingFile(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

async function runPrepareCommand(values) {
  const contractPath = values['--contract'];
  const contract = await readContract(contractPath);
  const hash = contractHash(contract);
  const stateDir = stateDirFor({ stateRoot: values['--state-root'], controller: values['--controller'] ?? 'default', contractHash: hash });
  if (contract.runtime === 'claude') {
    const result = await prepareClaude({ contract, contractPath, stateDir });
    process.stdout.write(`${JSON.stringify({
      runtime: 'claude', stateDir, contractHash: hash, settingsPath: result.settingsPath, hookScriptPath: result.hookScriptPath,
    })}\n`);
    return;
  }
  if (contract.runtime === 'codex') {
    const result = await prepareCodexProbesOnly({ stateDir });
    process.stdout.write(`${JSON.stringify({ runtime: 'codex', stateDir: result.stateDir, contractHash: hash })}\n`);
    return;
  }
  throw new Error(`unsupported runtime: ${contract.runtime}`);
}

// 显式传入才抬预算：不传就是 undefined，resumeRpcOps 据此省略 tokenBudget 参数。
export function parseRaiseTokenBudget(values) {
  const raw = values['--raise-token-budget'];
  if (raw === undefined) return undefined;
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error('--raise-token-budget must be a positive integer');
  return Number(raw);
}

async function runAttemptCommand(command, values) {
  const contract = await readContract(values['--contract']);
  const stateDir = values['--state'];
  const binding = await readBindingFile(values['--binding-file']);
  // 长内容先落权限受控文件，读文件 bytes 再以单一 argv 传给 claude（不拼 shell 字符串）。
  const prompt = command === 'launch' ? await readFile(values['--prompt-file'], 'utf8') : undefined;
  // 注入文本不由这份文件直接充当：它只声明「哪几条 contract 声明过的 postflight 条目红了、退出码
  // 是多少」，文本由 compileResumeDiagnostic 按 contract 渲染（见那里的成因）。形状不合即进程级失败，
  // 与「diagnostics 文件读不出」同一格（exit 1）：把不合形状的文件放行才是这条闸的失效方式。
  const diagnostic = command === 'resume'
    ? compileResumeDiagnostic({ text: await readFile(values['--diagnostics-file'], 'utf8'), contract })
    : { ok: true, text: undefined };
  if (!diagnostic.ok) throw new Error(diagnostic.reasons.join('\n'));
  const diagnosticText = diagnostic.text;
  const raiseTokenBudget = parseRaiseTokenBudget(values);

  // outcome=terminal_report 与「起飞且拿到候选」此前同为 exit 0，「根本没起飞」因此对只读退出码
  // 的编排器不可见（第二次冒烟 N-1）。改置 3：与进程级失败(1)、usage(2) 各自区分开，读退出码
  // 也 fail-closed。stdout 的报告体仍是唯一权威，reasons 只在那里。
  const emit = (result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.outcome === 'terminal_report') process.exitCode = 3;
  };

  if (contract.runtime === 'codex') {
    emit(command === 'launch'
      ? await runCodexLaunch({
        contract, stateDir, binding, prompt,
      })
      : await runCodexResume({
        contract, stateDir, binding, diagnosticText, raiseTokenBudget,
      }));
    return;
  }

  // claude 侧没有 tokenBudget 这个原生参数——静默忽略会让操作员以为预算抬上去了。
  if (raiseTokenBudget !== undefined) {
    throw new Error('--raise-token-budget only applies to the codex runtime');
  }
  emit(await runClaudeAttempt({
    contract, stateDir, binding, prompt, kind: command, diagnosticText,
  }));
}

// finalize 的判定权威始终是它写出的两份证据文件里的 `ok`（nextAction 读的就是那两份），退出码
// 只是给编排器的粗信号。但「归因不成立」此前与「归因成立」同为 exit 0——与 launch/resume 改置 3
// 之后的语义不一致，读退出码的编排器在这一格上仍然 fail-open。归因不成立即 exit 3，四格对齐。
async function runFinalizeCommand(values) {
  const binding = await readBindingFile(values['--binding-file']);
  const result = await runCodexFinalize({ stateDir: values['--state'], binding });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.attribution.ok) process.exitCode = 3;
}

async function runCloseCommand(values) {
  const result = await runCodexClose({ stateDir: values['--state'] });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.cleanupComplete !== true) process.exitCode = 3;
}

async function runCli() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  try {
    if (parsed.command === 'prepare') {
      await runPrepareCommand(parsed.values);
      return;
    }
    if (parsed.command === 'finalize') {
      await runFinalizeCommand(parsed.values);
      return;
    }
    if (parsed.command === 'close') {
      await runCloseCommand(parsed.values);
      return;
    }
    if (parsed.command === 'readback') {
      // 观测工具恒 exit 0：available:false 是「看不到」不是「出事了」，把它标成非零会诱导编排器
      // 把观测缺席当成 run 故障处理。
      process.stdout.write(`${JSON.stringify(await runClaudeReadback({ stateDir: parsed.values['--state'] }))}\n`);
      return;
    }
    await runAttemptCommand(parsed.command, parsed.values);
  } catch (error) {
    process.stderr.write(`${renderCliError(error)}\n`);
    process.exitCode = 1;
  }
}

// ContractArtifactError 的 message 只有 code+path；observed/expected/next 若只在字段里，launch CLI
// 的操作员永远看不到（validate-contract.mjs 渲染、这边不渲染，V7'）。两边同一格式，单点在此。
export function renderCliError(error) {
  return renderContractDiagnostic(error);
}

// Node 默认对模块做 realpath 解析，而 process.argv[1] 保留调用者敲入的字面路径。只比字面路径时，
// 任何经 symlink 的调用（已安装 skill 根目录本身就是 symlink）都会判定为「非入口」，runCli() 不执行、
// 进程 exit 0 且 stdout 为空——把「根本没启动」伪装成「启动成功」。
// 解法是两侧都归一化到 realpath 再比：Node 的两种解析姿态（默认 realpath 解析、
// --preserve-symlinks-main 保留字面）由此都落到同一个 canonical 形态上，不存在「两者都不匹配却确实
// 是入口」的形态。归一化失败（路径不存在等）时退回原字符串参与比较，绝不抛。
// 不要在这里加「文件名相同就当入口」之类的兜底：runCli() 会用宿主的 argv 分派 prepare/launch/
// resume/finalize/close 中的任意一条并覆写宿主 exitCode，那不是「多打一遍 usage」，是在别人的进程里
// 执行子命令。
export function isCliEntry(entryPath, moduleUrl) {
  if (typeof entryPath !== 'string' || entryPath.length === 0) return false;
  return canonicalPath(entryPath) === canonicalPath(fileURLToPath(moduleUrl));
}

if (isCliEntry(process.argv[1], import.meta.url)) {
  await runCli();
}
