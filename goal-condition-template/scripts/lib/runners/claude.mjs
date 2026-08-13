// Claude-owned prepare, pointer, lease, execution, and readback lifecycle.
import { execFile as execFileCallback } from 'node:child_process';
import { realpathSync } from 'node:fs';
import {
  chmod, lstat, readFile, rm, stat, writeFile,
} from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

import {
  assertLaunchable, buildSettings, buildStopHook, launchSpec, normalizeTerminal, resumeSpec,
} from '../adapters/claude.mjs';
import { PermissionSpecifierError } from '../claude-permissions.mjs';
import { assertClaudeCertified } from '../claude-capability.mjs';
import { assertFixedClaudeCertificationProfile } from '../claude-certification.mjs';
import { canonicalJson, contractHash } from '../contract.mjs';
import {
  AttemptClaimError, canonicalPath, initStateDir, nextAttempt, readControllerJsonNoFollow,
  removeOwnedControllerFile, writeControllerJsonExclusive,
} from '../runner-common.mjs';

const execFile = promisify(execFileCallback);

const CLAUDE_POINTER_KEYS = Object.freeze([
  'additionalReadRootIdentities', 'additionalReadRoots', 'cwd', 'promptSha256', 'schemaVersion',
  'sessionId', 'targetRootIdentities', 'targetRoots', 'transcriptPath',
]);
const LEGACY_CLAUDE_POINTER_KEYS = Object.freeze([
  'additionalReadRoots', 'cwd', 'promptSha256', 'sessionId', 'targetRoots', 'transcriptPath',
]);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isAbsolutePathList(value) {
  return Array.isArray(value)
    && value.every((entry) => typeof entry === 'string' && isAbsolute(entry));
}

function isRootIdentityList(value) {
  return Array.isArray(value) && value.every((identity) => identity !== null
    && typeof identity === 'object'
    && !Array.isArray(identity)
    && JSON.stringify(Object.keys(identity).sort()) === JSON.stringify(['dev', 'ino'])
    && /^(?:0|[1-9]\d*)$/.test(identity.dev)
    && /^(?:0|[1-9]\d*)$/.test(identity.ino));
}

function isClaudePointer(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(CLAUDE_POINTER_KEYS)) return false;
  if (value.schemaVersion !== 2) return false;
  if (!UUID_V4.test(value.sessionId)) return false;
  if (typeof value.cwd !== 'string' || !isAbsolute(value.cwd)) return false;
  if (!HEX64.test(value.promptSha256)) return false;
  if (typeof value.transcriptPath !== 'string' || !isAbsolute(value.transcriptPath)) return false;
  if (!isAbsolutePathList(value.targetRoots) || value.targetRoots.length === 0) return false;
  if (!isAbsolutePathList(value.additionalReadRoots)) return false;
  if (!isRootIdentityList(value.targetRootIdentities)
    || value.targetRootIdentities.length !== value.targetRoots.length) return false;
  if (!isRootIdentityList(value.additionalReadRootIdentities)
    || value.additionalReadRootIdentities.length !== value.additionalReadRoots.length) return false;
  return true;
}

function isLegacyClaudePointer(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(LEGACY_CLAUDE_POINTER_KEYS);
}

async function observeTargetIdentity(pathname) {
  const st = await stat(pathname, { bigint: true });
  if (!st.isDirectory()) throw new Error('target root is not a directory');
  return { dev: st.dev.toString(), ino: st.ino.toString() };
}
const CLAUDE_ATTEMPT_LEASE = 'claude-attempt.lock';

async function claimClaudeAttemptLease(stateDir) {
  const pathname = join(stateDir, CLAUDE_ATTEMPT_LEASE);
  const token = randomUUID();
  try {
    const ownership = await writeControllerJsonExclusive(pathname, {
      schemaVersion: 1, token, pid: process.pid, startedAt: Date.now(),
    });
    return { pathname, token, ownership };
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    throw new AttemptClaimError('CLAUDE_ATTEMPT_IN_PROGRESS entry=claude-attempt.lock field=lease '
      + 'observed=another controller holds the per-state Claude attempt lease '
      + 'expected=at most one launch or resume may reserve and dispatch against a state directory '
      + 'next=wait for the live attempt to finish; if its controller crashed, reconcile the claimed session '
      + 'before explicitly removing the stale lease or start under a fresh --controller name');
  }
}

async function releaseClaudeAttemptLease(lease) {
  const current = await readControllerJsonNoFollow(lease.pathname);
  if (!current.ok || current.value?.schemaVersion !== 1 || current.value?.token !== lease.token) {
    throw new Error('Claude attempt lease ownership changed; refusing to remove a foreign lease');
  }
  await removeOwnedControllerFile(lease.pathname, lease.ownership);
}

export async function hookRunCount(stateDir) {
  let text;
  try {
    text = await readFile(join(stateDir, 'hook-runs.jsonl'), 'utf8');
  } catch {
    return 0;
  }
  return text.split('\n').filter((line) => line.trim().length > 0).length;
}

// 默认采集器：真实 execFile('claude', ['--version']) + lstat + sha256。测试通过 prepareClaude
// 的 collect 参数注入 stub，不真调 claude 二进制。
export function helpAdvertisesLongOption(helpText, option) {
  if (typeof helpText !== 'string' || typeof option !== 'string' || !/^--[a-z0-9-]+$/.test(option)) return false;
  const escaped = option.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[\\s,])${escaped}(?=[\\s=,]|$)`, 'm').test(helpText);
}

async function defaultCollect({ hookScriptPath }) {
  const { stdout } = await execFile('claude', ['--version']);
  const match = stdout.match(/(\d+\.\d+\.\d+)/);
  // --session-id 能力探测直接问 --help，不做版本推断（代理指标不得严于/替代直接检查）：flag
  // 何时引入无从由版本下限证明，而它现在是否存在可以直接观测。探测失败按「不存在」落盘——
  // launch 前置闸据此落红，fail closed，不把「问不出来」当「有」。
  let helpStdout = '';
  try {
    ({ stdout: helpStdout } = await execFile('claude', ['--help']));
  } catch {
    helpStdout = '';
  }
  const bytes = await readFile(hookScriptPath);
  const st = await lstat(hookScriptPath);
  return {
    claudeVersionRaw: stdout,
    claudeVersion: match ? match[1] : null,
    claudeSessionIdFlag: helpAdvertisesLongOption(helpStdout, '--session-id'),
    claudeSettingSourcesFlag: helpAdvertisesLongOption(helpStdout, '--setting-sources'),
    hookMode: (st.mode & 0o7777).toString(8).padStart(4, '0'),
    hookSha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

// 幂等重写：prepareClaude 对同一 stateDir 必须可重入（如 requires_env 缺失 throw 之后，操作员
// 补齐环境变量重跑 prepare 是这条校验本身邀请的补救动作），runClaudeAttempt 也用它每轮把 settings
// 覆写回盘。因此这是一个「按路径写任意内容」的原语，绝不能原地覆写：原地写**跟着 symlink 走**
// （把 state 目录里的 settings.json 换成指向他人文件的符号链接，受害文件就会被 JSON 覆写，
// chmod 还会穿透过去改它的 mode），hardlink 那一路连 lstat 都看不出来（N3 实测两路都成立）。
// 先删再以 O_EXCL 新建把两路一起关掉——比「lstat 判是不是 symlink」彻底：落盘的永远是本目录里
// 一个新建的 regular file。删除与新建之间若有人抢先放回同名条目，wx 会 EEXIST 抛错，fail-closed。
// 顺带消掉了原先「先 chmod 0600 拿回写权限」那一步（删除只要目录写权限，不需要文件本身可写），
// 终态 mode 因此完全由 finalMode 决定，不再依赖调用历史。
async function writeReplacing(path, content, finalMode) {
  await rm(path, { force: true });
  await writeFile(path, content, { flag: 'wx' });
  if (finalMode !== undefined) await chmod(path, finalMode);
}

// 六步：见 spec §5 + task-8 brief。执行侧采集在这，纯函数判定在 adapters/claude.mjs 的
// assertLaunchable（本函数只落盘 probes，不下 ok/reasons 结论）。
export async function prepareClaude({ contract, contractPath, stateDir, collect = defaultCollect }) {
  // 1. 规范路径——S5 的 /var/folders 字面失配教训：hook/deny 全用 realpath 之后的形态。
  await initStateDir(stateDir);
  const realStateDir = realpathSync(stateDir);

  // 2. 生成并落盘 Stop hook，chmod 0500。
  const { script } = buildStopHook({ contract, stateDir: realStateDir });
  const hookScriptPath = join(realStateDir, 'stop-hook.mjs');
  await writeReplacing(hookScriptPath, script, 0o500);
  const expectedHookSha256 = createHash('sha256').update(script, 'utf8').digest('hex');

  // 3. requires_env 并集：缺一即 throw，不静默；命中的值只落 state 目录（0700/0600），不进 git/日志。
  const envNames = new Set();
  for (const entry of contract.postflight ?? []) {
    for (const name of entry.requires_env ?? []) envNames.add(name);
  }
  const missing = [...envNames].filter((name) => process.env[name] === undefined);
  if (missing.length > 0) {
    throw new Error(`requires_env missing from the launching environment: ${missing.join(', ')}`);
  }
  const envValues = Object.fromEntries([...envNames].map((name) => [name, process.env[name]]));
  const hookEnvPath = join(realStateDir, 'hook-env.json');
  await writeReplacing(hookEnvPath, JSON.stringify(envValues), 0o600);

  // 4. settings.json。contract 层只校验 raw 字符串，但进权限 DSL 的是 realpath 后的值——realpath
  // 含括号/换行时 buildSettings 会抛 assertPermissionSpecifier 的 TypeError。包成干净 ContractArtifactError，
  // 别让操作员拿到裸 TypeError（V7，DeepSeek 独有）。诊断只说形态，不回显具体路径值（隐私纪律）。
  const targetRoots = (contract.target_roots ?? []).map(canonicalPath);
  const additionalReadRoots = (contract.execution_permissions?.additional_read_roots ?? []).map(canonicalPath);
  let settings;
  try {
    settings = buildSettings({
      contract, hookScriptPath, stateDir: realStateDir, targetRoots, additionalReadRoots,
    });
  } catch (error) {
    // 只罩 assertPermissionSpecifier 的 TypeError 路径。其余 throw 是真 bug，包成权限诊断会把
    // 操作员引去改一个没毛病的 contract（V7'）——原样 rethrow。
    if (!(error instanceof PermissionSpecifierError)) throw error;
    throw new ContractArtifactError({
      code: 'PERMISSION_SPECIFIER_UNREPRESENTABLE',
      path: 'target_roots/execution_permissions',
      observed: 'a canonicalized path or permission value cannot be represented in the Claude permission DSL',
      expected: 'canonical paths and permission values free of parentheses, line breaks, and edge whitespace',
      next: 'adjust the offending value; note the realpath (not just the literal) is what gets compiled',
    });
  }
  const settingsPath = join(realStateDir, 'settings.json');
  await writeReplacing(settingsPath, JSON.stringify(settings, null, 2), 0o600);

  // 5. 采集 probes（spec §5「事先采集并落盘」——含原始输出，不是只留判定结论）。
  const collected = await collect({ hookScriptPath });
  const probes = {
    contractPath: contractPath ?? null,
    claudeVersionCommand: ['claude', '--version'],
    claudeVersionRaw: collected.claudeVersionRaw,
    claudeVersion: collected.claudeVersion,
    claudeHelpCommand: ['claude', '--help'],
    claudeSessionIdFlag: collected.claudeSessionIdFlag === true,
    claudeSettingSourcesFlag: collected.claudeSettingSourcesFlag === true,
    settings,
    hookScript: {
      path: hookScriptPath, exists: true, mode: collected.hookMode, sha256: collected.hookSha256,
    },
    expectedHookSha256,
  };
  const probesPath = join(realStateDir, 'probes.json');
  // 与上面三处同走 writeReplacing：本函数四个落盘点都是「按路径写任意内容」，漏掉一个就留一个
  // 完整的 symlink/hardlink 写原语（N3）。
  await writeReplacing(probesPath, JSON.stringify(probes, null, 2));

  // 6.
  return { settingsPath, hookScriptPath, probes };
}

// claude -p 的会话 transcript 落在 ~/.claude/projects/<slug(cwd)>/<sessionId>.jsonl；slug 规则
// （绝对路径中非 [A-Za-z0-9-] 的字符一律替换成 '-'）是 CLI 内部实现、无稳定性承诺——spike S-C
// 在 2.1.228 实测确认。因此这条路径只作观测通道（readback，fail-open）：规则漂移的表现是
// 「文件不存在 → available:false」，绝不进入判定或证据链。
export function claudeTranscriptPath({ cwd, sessionId }) {
  const slug = String(cwd).replace(/[^A-Za-z0-9-]/g, '-');
  return join(homedir(), '.claude', 'projects', slug, `${sessionId}.jsonl`);
}

// 现场重新 lstat/hash hook 文件——probes.json 记的是 prepare 时刻的观测，attempt 之间可能被
// 篡改；不信任缓存值，每次 attempt 都重新采集这一项再交 assertLaunchable 判定。路径由调用方
// 从 stateDir 推出，不从 probes.json 里读（否则是在被篡改的路径上重采，等于零收益）。
async function observeHookScript(hookScriptPath) {
  try {
    const bytes = await readFile(hookScriptPath);
    const st = await lstat(hookScriptPath);
    return {
      path: hookScriptPath,
      exists: true,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      mode: (st.mode & 0o7777).toString(8).padStart(4, '0'),
    };
  } catch {
    return {
      path: hookScriptPath, exists: false, sha256: null, mode: null,
    };
  }
}

const HEX64 = /^[0-9a-f]{64}$/;

// 六步（task-9 brief，T9 裁决更新 runBinding 接入）：binding 与 stateDir 的
// hash 三方交叉（binding.contractHash 对不上 prepare 时落盘的 stateDir 末段即终局，抓的是
// 「binding 缺失/损坏/prepare 之后 contract 被换」这类漂移，execFileImpl 一次都不调）→ 现场重算
// 判定输入并合成 probes 交 assertLaunchable 前置判定（红→终局报告）→ launchSpec/resumeSpec 组 argv →
// nextAttempt 占位 → execFileImpl 采集原始 result（claude -p 非零退出/is_error 时 stdout 仍是
// result JSON，先从 error.stdout 回捞再 JSON.parse，解析不出才按进程失败终局）→ normalizeTerminal
// 归一化（ok→候选，即使 terminal_reason 是 max_turns_reached 等「未达」也如实标注为候选，不是终局；
// not ok→终局报告）。候选与终局都不做 postflight——那是主会话的独立职责。
async function executeClaudeAttempt({
  contract, stateDir, prompt, kind, diagnosticText, binding, execFileImpl = execFile,
  beforeDispatch = async () => {},
}) {
  // attempt 号只在所有前置闸全绿、真要 spawn 执行器时才占（第二次冒烟 N-2）：真实 dispatch
  // 之后不可撤销；pre-dispatch rollback 只能在下面的 Claude 独占 lease 内进行。前置闸拒绝的原因
  // 经常在 contract 之外（binding 笔误、claude 版本掉出 allowlist、hook 文件
  // 模式被改），改正它们不会换 contract hash，也就不会换 state 目录。占在闸前意味着三次笔误就把
  // 这份 contract 在这个 state 目录上永久锁死。它也与 claude.md 的计数口径冲突——那里定义的是
  // 「一次逻辑 run = 1 首发 + 最多 2 次续跑」，约束的是真实跑过的轮次。
  let attemptNumber = null;
  // 每个返回体都带上 attemptNumber 与本刻的 hook 运行次数；候选另带 hookExpected，控制器只把
  // hookExpected=true 的轮次计入期望值。这样既能把 hook 静默缺席（resume 未继承 --settings、
  // hook 被绕过删除）变成可验证的红，也不会把不触发 Stop 的 max-turns 硬停误算成缺席。
  // 前置闸拒绝时 attemptNumber 为 null——显式的「没有轮次可对账」，与「字段缺失」区分开。
  const finish = async (result) => ({
    ...result, attemptNumber, hookRuns: await hookRunCount(stateDir),
  });

  // binding（主会话持有的 runBinding={contractHash,baselineDigest,runId}）缺失、JSON 损坏、
  // 或 contractHash 对不上 stateDir 末段（prepare 时确认并落盘的 hash），在这一步统一 fail-closed：
  // undefined/null 的 binding?.contractHash 永远不等于真实 hex hash，天然落进这条终局报告。
  if (binding?.contractHash !== basename(stateDir)) {
    return finish({
      outcome: 'terminal_report',
      reasons: ['runBinding is missing, malformed, or does not match the state directory this attempt was prepared under'],
    });
  }

  // probes.json 与被判定的对象同在一个 0700 目录里，执行器与控制器同 uid——它能被写，就不能
  // 当作判定输入的真值源（终审 I1 实测：改一次 probes.json 即整体绕过本闸，attempt 带着攻击者
  // 的 settings 与空壳 hook 正常起飞）。因此 assertLaunchable 的五项输入里有四项在这里现场重算：
  // hook 路径与 settings 路径由 stateDir 推出（与 prepare 同一 realpath 形态）、期望 hash 由
  // contract 现场重新生成 hook 脚本再算、settings 全文现场重新生成。留在 probes.json 里读的只有
  // claudeVersion——它是一次外部进程观测，无法在纯判定路径上重放。
  const storedProbes = JSON.parse(await readFile(join(stateDir, 'probes.json'), 'utf8'));
  const realStateDir = realpathSync(stateDir);
  const hookScriptPath = join(realStateDir, 'stop-hook.mjs');
  const { script } = buildStopHook({ contract, stateDir: realStateDir });
  const expectedHookSha256 = createHash('sha256').update(script, 'utf8').digest('hex');
  const targetRoots = (contract.target_roots ?? []).map(canonicalPath);
  const additionalReadRoots = (contract.execution_permissions?.additional_read_roots ?? []).map(canonicalPath);
  let targetRootIdentities;
  let additionalReadRootIdentities;
  try {
    targetRootIdentities = await Promise.all(targetRoots.map(observeTargetIdentity));
    // additional_read_roots 进 settings.additionalDirectories，与 target root 一样是授权的目录面，
    // 必须同等绑定 device/inode 并在 spawn 前复核（V6，Codex 独有 P1）——否则替换 read-root 目录
    // 能把授权读路径重定向到无关数据，而不触发任何前置检查。
    additionalReadRootIdentities = await Promise.all(additionalReadRoots.map(observeTargetIdentity));
  } catch {
    return finish({
      outcome: 'terminal_report',
      reasons: ['a canonical target or additional read root is not a readable directory, so its launch identity cannot be bound'],
    });
  }
  let settings;
  try {
    settings = buildSettings({
      contract, hookScriptPath, stateDir: realStateDir, targetRoots, additionalReadRoots,
    });
  } catch (error) {
    if (!(error instanceof PermissionSpecifierError)) throw error;
    return finish({
      outcome: 'terminal_report',
      reasons: ['Claude permission settings contain an invalid permission specifier and cannot be compiled'],
    });
  }
  const settingsPath = join(realStateDir, 'settings.json');
  // The lease begins before the first shared-state mutation of an attempt. If it started at attempt reservation,
  // a losing concurrent resume could still replace settings.json underneath the active executor before being
  // rejected. Holding it through settings publication, validation, reservation, dispatch, and result persistence
  // makes the whole attempt a single-writer transaction.
  const attemptLease = await claimClaudeAttemptLease(stateDir);
  let pointerOwnership = null;
  try {
  // hook 脚本走的是「读磁盘 bytes → 与现场重算的 sha256 比对」，settings.json 此前没有同等待遇：
  // 判定的是上一行这个内存对象，交给 claude 的却是磁盘上的 settingsPath（re-review I1b 实测：把
  // 磁盘那份的 deny 改成 [] 即可带着空 deny 合法起飞）。这里不加第二道比对，而是每次 attempt 用
  // 现场生成的这份覆写回磁盘——判定对象与被消费对象按构造相等，中间不留可篡改的窗口；顺带让
  // prepare 之后才发生的路径/内容变动不再以过期 settings 的形式残留。
  await writeReplacing(settingsPath, JSON.stringify(settings, null, 2), 0o600);
  const hookScript = await observeHookScript(hookScriptPath);
  const probes = {
    claudeVersion: storedProbes.claudeVersion,
    // 与 claudeVersion 同一待遇：一次外部进程观测，无法在纯判定路径上重放，只能从 prepare 落盘
    // 的 probes.json 里读。显式 === true 归一：旧 state 目录（探测引入前 prepare 的）缺这个字段
    // 时判 false → 前置闸红 → 重跑 prepare 即可，不烧配额。
    claudeSessionIdFlag: storedProbes.claudeSessionIdFlag === true,
    claudeSettingSourcesFlag: storedProbes.claudeSettingSourcesFlag === true,
    contractHash: contractHash(contract),
    // confirmedHash 现在来自主会话的 runBinding 本体（不再是 stateDir 末段——那条检查已经
    // 上移成独立的三方交叉判定），与此刻现场重算的 contractHash 对比，抓的是「prepare 之后
    // contract 对象被换了」这类漂移。baselineDigestStored 同样来自 binding：主会话是否真的把
    // baseline digest 外存到了可信编排状态，执行层不再假装替上游验证一件看不到的事实。
    confirmedHash: binding?.contractHash,
    baselineDigestStored: typeof binding?.baselineDigest === 'string' && HEX64.test(binding.baselineDigest),
    targetRoots,
    additionalReadRoots,
    stateDir: realStateDir,
    settings,
    expectedHookSha256,
    hookScript,
  };

  const verdict = assertLaunchable(contract, probes);
  if (!verdict.ok) {
    return finish({ outcome: 'terminal_report', reasons: verdict.reasons });
  }

  const cwd = targetRoots[0];
  const threadPath = join(realStateDir, 'thread.json');

  let spec;
  let sessionId;
  if (kind === 'launch') {
    // 一次逻辑 run 只能 claim 一个 Claude 会话。已有可读指针时再次 launch 会把 resume 坐标
    // 换成新会话，与「1 launch + ≤2 resume」和 claim 后只 readback/reconcile 的恢复模型都冲突。
    // 损坏/不可读/链接形态都意味着 claim 状态不可证明，必须显式恢复，不能覆写后另起会话。
    const prior = await readControllerJsonNoFollow(threadPath);
    if (!prior.missing) {
      return finish({
        outcome: 'terminal_report',
        reasons: [prior.ok && isClaudePointer(prior.value)
          ? 'this run already claimed a claude session; use resume or readback instead of launching again'
          : prior.ok && isLegacyClaudePointer(prior.value)
            ? 'thread.json uses a legacy pointer schema without root identities; reconcile/read back the old '
              + 'session with its original adapter, then start a fresh controller state instead of re-running prepare'
            : 'thread.json exists but is invalid; recover it explicitly instead of launching a second session'],
      });
    }
    // claim-before-dispatch（借 codex GoalSession v2 的 LaunchIntent 语义）：会话身份由控制器
    // 预派，resume 指针在 spawn 之前落盘（见占号后那一步）。2026-08-10 真实 run 的 resume 死锁
    // 根因就是指针落在终局校验之后——error 形态 envelope 过不了单锚，指针永不落盘。
    sessionId = randomUUID();
    spec = launchSpec({
      prompt, settingsPath, cwd, budget: contract.budget, sessionId,
    });
  } else if (kind === 'resume') {
    const prior = await readControllerJsonNoFollow(threadPath);
    if (prior.missing) {
      return finish({
        outcome: 'terminal_report',
        reasons: ['no thread.json in state dir: cannot resume without a prior session id'],
      });
    }
    if (prior.ok && isLegacyClaudePointer(prior.value)) {
      return finish({
        outcome: 'terminal_report',
        reasons: ['thread.json uses a legacy pointer schema without root identities; reconcile/read back the old '
          + 'session with its original adapter, then start a fresh controller state instead of re-running prepare'],
      });
    }
    if (!prior.ok || !isClaudePointer(prior.value)) {
      return finish({
        outcome: 'terminal_report',
        reasons: ['thread.json exists but is invalid; recover the controller-issued pointer before resume'],
      });
    }
    // resume 绑 launch-time cwd：pointer.cwd 是首发时的 canonical target root，与此刻重算的 cwd
    // 必须相等。symlink target root 在 launch 后被重定向时二者分叉——若仍用当前 cwd 续跑，会在新
    // 目录里复活旧会话，且 settings/deny 面（当前根）与 spawn cwd 不一致（V2）。fail-closed 拒绝。
    if (prior.value.cwd !== cwd) {
      return finish({
        outcome: 'terminal_report',
        reasons: ['target root canonical path changed since launch; refusing to resume the session in a different directory'],
      });
    }
    // cwd 只覆盖 target_roots[0]。其余 target roots 与 additional read roots 同样进 settings 的
    // 授权面（additionalDirectories），launch 后被 symlink 重定向时 cwd 检查是盲的（V2'）——
    // pointer 记的全量 launch-time canonical roots 与此刻重算值必须逐字相等。
    if (JSON.stringify(prior.value.targetRoots) !== JSON.stringify(targetRoots)
      || JSON.stringify(prior.value.additionalReadRoots) !== JSON.stringify(additionalReadRoots)) {
      return finish({
        outcome: 'terminal_report',
        reasons: ['a target or additional read root canonical path changed since launch; refusing to resume with a drifted authorization surface'],
      });
    }
    if (JSON.stringify(prior.value.targetRootIdentities) !== JSON.stringify(targetRootIdentities)
      || JSON.stringify(prior.value.additionalReadRootIdentities)
        !== JSON.stringify(additionalReadRootIdentities)) {
      return finish({
        outcome: 'terminal_report',
        reasons: ['a target or additional read root identity changed since launch; refusing to resume in a replaced directory'],
      });
    }
    ({ sessionId } = prior.value);
    spec = resumeSpec({
      sessionId, settingsPath, diagnosticText, cwd, budget: contract.budget,
    });
  } else {
    throw new Error(`unsupported kind: ${kind}`);
  }

    // 前置闸全绿、argv 已组好后才预占 attempt。若后续 claim/rebind 在调用 execFileImpl 前失败，
    // lease 保证没有更高 attempt 并发出现，因此可以安全回收本次最高 slot。
    attemptNumber = await nextAttempt(stateDir);

    const releaseUndispatched = async () => {
      // pointer 先清、attempt 后清：若 owned-pointer rollback 失败，就保守保留已占 slot，避免把一个
      // 带残留 claim 的状态伪装成「零 dispatch、可重试」。同一 lease 排除了守约 controller 的替换。
      if (kind === 'launch' && pointerOwnership !== null) {
        await removeOwnedControllerFile(threadPath, pointerOwnership);
        pointerOwnership = null;
      }
      const reservedAttempt = attemptNumber;
      if (reservedAttempt !== null) {
        await rm(join(stateDir, 'attempts', String(reservedAttempt)), { force: true });
        attemptNumber = null;
      }
    };

    if (kind === 'launch') {
      // 指针先落盘再 spawn：无论终局形态如何（成功、error_max_turns、进程崩溃、stdout 不可解析），
      // resume 都有指针可用。私有 inode 完整写入、fsync 后用 hard-link no-replace 发布，失败不会
      // 留下半截 JSON，也不会为了回滚去 unlink 一个可能已被后来者占用的公共路径。
      try {
        pointerOwnership = await writeControllerJsonExclusive(threadPath, {
          schemaVersion: 2,
          sessionId,
          cwd,
          promptSha256: createHash('sha256').update(prompt, 'utf8').digest('hex'),
          transcriptPath: claudeTranscriptPath({ cwd, sessionId }),
          targetRoots,
          additionalReadRoots,
          targetRootIdentities,
          additionalReadRootIdentities,
        });
      } catch {
        await releaseUndispatched();
        return finish({
          outcome: 'terminal_report',
          reasons: ['thread.json was claimed concurrently or could not be published transactionally; refusing to dispatch a second session'],
        });
      }
    }

  // The permission rules and cwd are bound to the same canonical roots. Recheck device/inode after
  // every async claim step and immediately before spawn so replacing a canonical directory cannot
  // redirect execution into a repository outside the authorization surface bound above.
  try {
    await beforeDispatch({
      cwd, targetRoots: [...targetRoots], additionalReadRoots: [...additionalReadRoots],
    });
    const rebound = async (roots, identities) => {
      for (let index = 0; index < roots.length; index += 1) {
        const current = await observeTargetIdentity(roots[index]);
        const bound = identities[index];
        if (current.dev !== bound.dev || current.ino !== bound.ino) return false;
      }
      return true;
    };
    if (!await rebound(targetRoots, targetRootIdentities)
      || !await rebound(additionalReadRoots, additionalReadRootIdentities)) {
      await releaseUndispatched();
      return finish({
        outcome: 'terminal_report',
        reasons: ['canonical root identity changed before dispatch; refusing to spawn Claude'],
      });
    }
  } catch {
    await releaseUndispatched();
    return finish({
      outcome: 'terminal_report',
      reasons: ['pre-dispatch verification failed before the executor was invoked; refusing to spawn Claude'],
    });
  }

  let raw;
  try {
    const { stdout } = await execFileImpl(spec.argv[0], spec.argv.slice(1), { cwd, maxBuffer: 32 * 1024 * 1024 });
    try {
      raw = JSON.parse(stdout);
    } catch {
      return finish({ outcome: 'terminal_report', reasons: ['claude stdout is not valid JSON'] });
    }
  } catch (error) {
    // claude -p 非零退出/is_error 时 stdout 仍是 result JSON——execFile throw 时先从
    // error.stdout 回捞，解析不出才按进程失败终局（不是 stdout 非 JSON 那条理由）。
    if (typeof error?.stdout === 'string') {
      try {
        raw = JSON.parse(error.stdout);
      } catch {
        return finish({ outcome: 'terminal_report', reasons: [`claude process failed: ${error.message}`] });
      }
    } else {
      return finish({ outcome: 'terminal_report', reasons: [`claude process failed: ${error.message}`] });
    }
  }

  await writeFile(join(stateDir, 'attempts', `${attemptNumber}-result.json`), JSON.stringify(raw, null, 2));

  const normalized = normalizeTerminal(raw);
  if (!normalized.ok) {
    return finish({ outcome: 'terminal_report', reasons: normalized.reasons });
  }

  // 身份交叉核验：envelope 回显的 session_id 必须等于控制器持有的那一个（launch=预派值，
  // resume=thread.json 指针）。对不上说明候选归属存疑——fail closed 落终局，不吞进候选；
  // thread.json 保持控制器写入的值不动，执行体侧的回显永远不反向覆写指针。
  if (raw.session_id !== sessionId) {
    return finish({
      outcome: 'terminal_report',
      reasons: ['claude reported a session_id different from the controller-issued one: the candidate cannot be attributed to this run'],
    });
  }

  await writeFile(join(stateDir, 'candidate.json'), JSON.stringify(normalized.candidate, null, 2));

  // budgetExhausted 是报告体字段不进 candidate（candidate 恒 4 字段，见 normalizeTerminal）：
  // 控制器据它把「预算耗尽」路由到未达标可续分流，而不是把 reject 的形状红当成协议漂移。
  return finish({
    outcome: 'candidate',
    candidate: normalized.candidate,
    sessionId,
    budgetExhausted: normalized.budgetExhausted,
    // max-turns 硬停不会触发 Stop 事件；它不应被旧的 attemptNumber 口径误算成 hook 缺席。
    // 控制器累计对账 hookRuns 时只计 hookExpected=true 的候选 attempt。
    hookExpected: !normalized.budgetExhausted,
  });
  } finally {
    await releaseClaudeAttemptLease(attemptLease);
  }
}

export async function runClaudeAttempt(options) {
  // Capability is the outermost ordinary-launch gate. Candidate state must not reach any state-dir
  // mutation, attempt reservation, session claim, settings publication, or executor dispatch.
  assertClaudeCertified(options?.capabilityContext);
  return executeClaudeAttempt(options ?? {});
}

export async function runClaudeCertificationAttempt({ compiled, ...options }) {
  const fixed = assertFixedClaudeCertificationProfile(compiled);
  if (canonicalJson(options.contract) !== fixed.canonicalBytes) {
    throw new Error('CLAUDE_CERTIFICATION_PROFILE_INVALID: adapter contract differs from the fixed canary');
  }
  return executeClaudeAttempt(options);
}

// claude 线只读观测通道（transcript readback）：不 spawn、不写盘、不把 transcript 字节放进
// 输出——只给计数、条目类型与哈希比对结论（隐私纪律：任务内容不回显）。任何内部失败都归
// {available:false}：观测不可用不等于 run 出事，兜底永远是 wall-clock deadline，不是这里。
// 它的结论也不进任何 controller 证据通道——这是给「干完了还是卡住了」的独立观测面，处置
// （kill / resume / 继续等）留给人工决策。
export async function runClaudeReadback({ stateDir }) {
  const pointerRead = await readControllerJsonNoFollow(join(stateDir, 'thread.json'));
  if (pointerRead.missing) {
    return { available: false, reasons: ['no readable thread.json in the state dir'] };
  }
  if (!pointerRead.ok) {
    return { available: false, reasons: ['thread.json exists but is invalid or unsafe to read'] };
  }
  const pointer = pointerRead.value;
  if (typeof pointer?.threadId === 'string') {
    return { available: false, reasons: ['this state dir belongs to a codex run: readback here is claude-only'] };
  }
  if (!isClaudePointer(pointer)) {
    return {
      available: false,
      reasons: [isLegacyClaudePointer(pointer)
        ? 'thread.json uses a legacy pointer schema; read it back with the original adapter, reconcile that '
          + 'session, then start future work under a fresh controller state'
        : 'thread.json has an unsupported pointer shape: launch under the current adapter to enable readback'],
    };
  }
  let st;
  try {
    st = await lstat(pointer.transcriptPath);
  } catch {
    return {
      available: false,
      reasons: ['transcript not found at the recorded path: the session may not have started yet, or the CLI transcript layout drifted'],
    };
  }
  let text;
  try {
    text = await readFile(pointer.transcriptPath, 'utf8');
  } catch {
    return { available: false, reasons: ['transcript is not readable by the controller'] };
  }
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  let lastEntryType = null;
  let firstUserSha256 = null;
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry?.type === 'string') {
      lastEntryType = new Set([
        'assistant', 'user', 'system', 'result', 'queue-operation', 'progress', 'summary',
      ]).has(entry.type) ? entry.type : 'unknown';
    }
    if (firstUserSha256 === null && entry?.type === 'user') {
      const content = entry?.message?.content;
      const textPart = typeof content === 'string' ? content
        : (Array.isArray(content) && content[0]?.type === 'text' ? content[0].text : null);
      if (typeof textPart === 'string') {
        firstUserSha256 = createHash('sha256').update(textPart, 'utf8').digest('hex');
      }
    }
  }
  // 归因是报告信号不是闸：mismatch 说明「transcript 首条 user 输入不是控制器发出的 prompt」，
  // 值得人工核查，但 readback 无权据此终止任何东西。
  const promptAttribution = typeof pointer.promptSha256 !== 'string' || firstUserSha256 === null
    ? 'unavailable'
    : (firstUserSha256 === pointer.promptSha256 ? 'match' : 'mismatch');
  return {
    available: true,
    mtimeMs: st.mtimeMs,
    lineCount: lines.length,
    lastEntryType,
    promptAttribution,
  };
}
