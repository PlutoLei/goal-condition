// Claude runtime adapter 纯函数。执行豁口在 scripts/launch.mjs；本文件不 spawn、不读写盘。

import {
  isAbsolute, join, relative, sep,
} from 'node:path';

import {
  assertPermissionSpecifier, permissionRule, permissionSpecifierProblem,
} from '../claude-permissions.mjs';

// 版本闸是**下限**不是精确 allowlist。它想挡的是 result envelope 形状漂移，可那是个代理指标——
// 真正要防的东西下面的 21-key 全集校验已经**直接**在管：envelope 没变的新版本被精确 allowlist 拦下
// 是纯误杀，envelope 真变了的新版本直检照样红且诊断更精确。代理指标严于直接指标，代价却是 claude
// 每隔几天升一次版就「工具不可用」（2026-08-09 真实触发：2.1.225 上线，allowlist 只有 2.1.223），
// 而那种闸的真实结局是有人把它注释掉。下限只排除已知过旧的版本。
export const CLAUDE_VERSION_FLOOR = '2.1.223';

// 实测锚定版本 2.1.223 的 result envelope 完整 key 集（spike S3 抓取）。SDK 文档与实现存在字段漂移，
// 以实测集为准；升版改了 envelope 由 normalizeTerminal 落红，核对新版本 envelope 后再改这张表。
export const CLAUDE_RESULT_KEYS = Object.freeze([
  'api_error_status', 'duration_api_ms', 'duration_ms', 'fast_mode_disabled_reason',
  'fast_mode_state', 'is_error', 'modelUsage', 'num_turns', 'permission_denials',
  'result', 'session_id', 'stop_reason', 'subtype', 'terminal_reason',
  'time_to_request_ms', 'total_cost_usd', 'ttft_ms', 'ttft_stream_ms', 'type', 'usage', 'uuid',
]);

const EXPECTED_KEYS = new Set(CLAUDE_RESULT_KEYS);

// max-turns 硬停的 error 形态 envelope 完整 key 集：2.1.226 真实 run 与 2.1.228 spike S-B 逐 key
// 一致（比成功锚少 api_error_status/result/time_to_request_ms/ttft_ms/ttft_stream_ms、多 errors，
// terminal_reason 取值 max_turns）。只为实测过的 error_max_turns 建锚；其他 error subtype 没有
// 实测锚，一律按成功锚落红（fail closed）——「没干完」和「协议漂移」是两类事，2026-08-10 真实
// run 曾因单锚把前者判成后者而封死续跑。
export const CLAUDE_ERROR_MAX_TURNS_KEYS = Object.freeze([
  'duration_api_ms', 'duration_ms', 'errors', 'fast_mode_disabled_reason', 'fast_mode_state',
  'is_error', 'modelUsage', 'num_turns', 'permission_denials', 'session_id', 'stop_reason',
  'subtype', 'terminal_reason', 'total_cost_usd', 'type', 'usage', 'uuid',
]);

const ERROR_MAX_TURNS_KEYS = new Set(CLAUDE_ERROR_MAX_TURNS_KEYS);

// 版本闸放宽成下限之后，「新版本改了 result envelope」全靠这道直检兜底，所以诊断必须直接指路：
// 只说「多了 N 个未知 key」的操作员不知道下一步该干什么。隐私纪律不变——只给计数，不回显 key 名。
function driftHint(table) {
  return 'this may be a claude upgrade drifting the result envelope: '
    + `re-check the new version's result envelope, then update ${table}`;
}

// 已锚定的 error 形态不能共用 driftHint：subtype=error_max_turns 命中的是实测 17-key 锚，此时
// 拒收通常意味着「这一轮没干完」而不是「协议变了」。2026-08-13 真实排障里那句漂移话术把方向带偏
// 一小时，而当天 envelope 与锚定逐 key 一致。改为回显命中的锚与判别用的闭集值，让操作员自己分辨
// 两类事。隐私纪律不变：subtype 由分支条件恒定，terminal_reason 只回显闭集成员，其余一律折叠。
const RECOGNIZED_TERMINAL_REASONS = Object.freeze(['api_error', 'completed', 'max_turns']);

function anchoredShapeHint(raw) {
  const terminalReason = RECOGNIZED_TERMINAL_REASONS.includes(raw.terminal_reason)
    ? raw.terminal_reason : 'unrecognized';
  return 'the envelope declares the anchored error shape subtype=error_max_turns '
    + `terminal_reason=${terminalReason}; compare it key-by-key against `
    + 'CLAUDE_ERROR_MAX_TURNS_KEYS — a mismatch on this anchor usually means the run did not '
    + 'finish, not that the protocol changed';
}

export function normalizeTerminal(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reasons: ['Claude result must be an object'] };
  }
  // 锚按 subtype 二选一：error_max_turns 走 17-key error 锚，其余（含未知 error subtype）一律
  // 按 21-key 成功锚判。两个锚都是全集相等校验，互斥不重叠。
  const usesMaxTurnsAnchor = raw.subtype === 'error_max_turns';
  const budgetExhausted = usesMaxTurnsAnchor
    && raw.type === 'result'
    && raw.is_error === true
    && raw.terminal_reason === 'max_turns';
  const anchor = usesMaxTurnsAnchor ? CLAUDE_ERROR_MAX_TURNS_KEYS : CLAUDE_RESULT_KEYS;
  const anchorSet = usesMaxTurnsAnchor ? ERROR_MAX_TURNS_KEYS : EXPECTED_KEYS;
  const hint = usesMaxTurnsAnchor ? anchoredShapeHint(raw) : driftHint('CLAUDE_RESULT_KEYS');
  const missing = anchor.filter((key) => !Object.hasOwn(raw, key));
  const unknown = Object.keys(raw).filter((key) => !anchorSet.has(key));
  const reasons = [];
  if (missing.length) reasons.push(`Claude result is missing ${missing.length} required key(s); ${hint}`);
  if (unknown.length) reasons.push(`Claude result contains ${unknown.length} unknown key(s); ${hint}`);
  if (usesMaxTurnsAnchor && !budgetExhausted) {
    reasons.push('Claude error_max_turns result does not match the measured discriminator tuple');
  }
  if (reasons.length) return { ok: false, reasons };
  // Provider availability belongs to the controller report, not the four-field candidate. Preserve
  // only the bounded status needed for routing; never propagate result/errors/transcript bytes.
  const apiErrorStatus = Number(raw.api_error_status);
  const providerBlocker = Number.isInteger(apiErrorStatus)
    && (apiErrorStatus === 429 || apiErrorStatus >= 500)
    ? { api_error_status: apiErrorStatus }
    : null;
  // budgetExhausted 是给控制器报告体的路由信号（「预算耗尽、可续跑」），不进 candidate——
  // candidate 恒为 4 字段：workflow.mjs 的 claudeTerminalState 做闭世界形状检查，多一个字段
  // 就把「未达标候选」变成 reject 里的形状错误，两种红不是一回事。
  return {
    ok: true,
    budgetExhausted,
    providerBlocker,
    candidate: {
      subtype: raw.subtype,
      is_error: raw.is_error,
      terminal_reason: raw.terminal_reason,
      permission_denials: raw.permission_denials,
    },
  };
}

export const MAX_HOOK_BLOCKS = 8;

// hook 是续轮驱动器不是验收：它的结论不进任何 controller 证据通道，
// hook 全绿仍可能被控制器独立 postflight 推翻（如越权 mutation 仅 baseline compare 可见）。
export function buildStopHook({ contract, stateDir }) {
  const entries = contract.postflight.map(({ id, cwd, argv }) => ({ id, cwd, argv }));
  const budget = contract.budget;
  const maxBlocks = budget?.user_provided && typeof budget.max_turns === 'number'
    ? Math.min(MAX_HOOK_BLOCKS, Math.floor(budget.max_turns)) : MAX_HOOK_BLOCKS;
  const maxWallMs = budget?.user_provided && typeof budget.max_minutes === 'number'
    ? Math.round(budget.max_minutes * 60_000) : null;
  const script = `#!/usr/bin/env node
// controller 生成的 Stop hook（达标判定，多红收集不抛）。生成器: scripts/lib/adapters/claude.mjs
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const stateDir = ${JSON.stringify(stateDir)};
const entries = ${JSON.stringify(entries)};
const maxBlocks = ${maxBlocks};
const maxWallMs = ${maxWallMs === null ? 'null' : maxWallMs};

const envFile = join(stateDir, 'hook-env.json');
const extraEnv = existsSync(envFile) ? JSON.parse(readFileSync(envFile, 'utf8')) : {};
const env = { ...process.env, ...extraEnv };

const startedAtFile = join(stateDir, 'hook-started-at');
if (!existsSync(startedAtFile)) writeFileSync(startedAtFile, String(Date.now()));
const startedAt = Number(readFileSync(startedAtFile, 'utf8'));

const reds = [];
for (const entry of entries) {
  try {
    execFileSync(entry.argv[0], entry.argv.slice(1), { cwd: entry.cwd, env, stdio: 'ignore' });
  } catch {
    reds.push(entry.id);
  }
}

const countFile = join(stateDir, 'hook-blocks.count');
const blocks = existsSync(countFile) ? Number(readFileSync(countFile, 'utf8')) : 0;
const overWall = maxWallMs !== null && Date.now() - startedAt > maxWallMs;
let decision = 'allow';
if (reds.length > 0 && blocks < maxBlocks && !overWall) {
  decision = 'block';
  writeFileSync(countFile, String(blocks + 1));
}
appendFileSync(join(stateDir, 'hook-runs.jsonl'),
  JSON.stringify({ ts: Date.now(), reds, decision }) + '\\n');
if (decision === 'block') {
  const reason = 'postflight not green yet: ' + reds.join(', ')
    + '. Continue working toward the original objective, make these checks pass, then finish.';
  const reasonStr = JSON.stringify(reason);
  process.stdout.write('{"decision":"block","reason":' + reasonStr + '}');
}
process.exit(0);
`;
  return { script };
}

function shellSingleQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function unique(values) {
  return [...new Set(values)];
}

export function buildSettings({
  contract = {}, hookScriptPath, stateDir,
  targetRoots = contract.target_roots ?? [],
  additionalReadRoots = contract.execution_permissions?.additional_read_roots ?? [],
}) {
  const execution = contract.execution_permissions ?? {};
  // postflight verifier **不进** Bash allow-list（V5'）：argv 是 execFile 语义、Bash specifier 是
  // shell 字符串语义，两者之间没有可靠编码——argv[0] 通配把整个可执行家族授权出去（git diff 顺带
  // 授权 git push），argv.join(' ') 既 over-auth（['printf','%s','a; touch x'] 的 join 在 shell 里是
  // 两条命令）又 under-match（['git','diff','a b.txt'] 的 join 与真实 tokenize 永不匹配，规则静默
  // 死掉还让作者以为已授权）。verifier 的执行不依赖这条通道：hook 用 execFileSync 跑它（不经
  // claude permission）；执行体要自己跑 verifier 由作者显式 bash_prefixes 声明（:* 前缀语义）。
  for (const value of [
    ...(execution.bash_prefixes ?? []),
    ...(execution.webfetch_domains ?? []),
    ...(execution.skills ?? []),
    hookScriptPath,
    stateDir,
  ]) assertPermissionSpecifier(value);
  const allow = [
    ...unique(execution.bash_prefixes ?? []).map((prefix) => permissionRule('Bash', `${prefix}:*`)),
    ...(execution.webfetch_domains ?? []).map((domain) => permissionRule('WebFetch', `domain:${domain}`)),
    ...(execution.skills ?? []).map((skill) => permissionRule('Skill', skill)),
  ];
  const canonicalTargets = unique(targetRoots);
  const additionalDirectories = unique([
    ...canonicalTargets.slice(1),
    ...additionalReadRoots,
  ]);
  return {
    hooks: { Stop: [{ hooks: [{ type: 'command', command: `node ${shellSingleQuote(hookScriptPath)}` }] }] },
    // S5 实测：Edit deny 对简单 Bash 重定向也有效（permission_denials 实录 tool_name:Bash），
    // 但精确上限（语义级 vs 字面匹配）INCONCLUSIVE——不宣称完全物理保证。
    // deny 路径必须是 realpath 规范形（/var/folders vs /private/var/folders 的字面失配会让 deny 落空）。
    permissions: {
      allow,
      deny: [
        permissionRule('Edit', `/${hookScriptPath}`),
        permissionRule('Edit', `/${stateDir}/**`),
      ],
      additionalDirectories,
    },
  };
}

export const DEFAULT_MAX_TURNS = 50;
export const MAX_TURNS_CEILING = 200;

// 50 是未声明预算时的默认值，不是用户预算的静默上限。显式值原样进入 argv；超过 200 的形态
// 由 assertLaunchable 在 spawn 前拒绝。把两者混成 Math.min 会让用户写 51/200 仍只跑 50 轮，
// contract 与真实执行预算不一致；把 >200 静默钳制则同样是在改写已确认 contract。
export function effectiveMaxTurns(budget) {
  return budget?.user_provided && typeof budget.max_turns === 'number'
    ? budget.max_turns
    : DEFAULT_MAX_TURNS;
}

export function launchSpec({ prompt, settingsPath, cwd, budget, sessionId }) {
  // prompt 由调用方从权限受控文件 bytes 读出、单 argv 传入（现行规则）；本函数纯数据不执行。
  // sessionId 由控制器预派（claim-before-dispatch）：resume 指针在 spawn 之前就落盘，max-turns
  // 硬停、进程崩溃、stdout 不可解析等一切终局形态下都不丢指针。CLI 对重复 UUID 明确拒绝
  // （spike S-A 实测），预派不会静默串台。
  return {
    argv: ['claude', '-p', prompt, '--output-format', 'json', '--session-id', sessionId,
      '--setting-sources', '',
      '--settings', settingsPath, '--permission-mode', 'acceptEdits',
      '--max-turns', String(effectiveMaxTurns(budget))],
    settingsPath, cwd, env_names: [],
  };
}

export function resumeSpec({
  sessionId, settingsPath, diagnosticText, cwd, budget,
}) {
  return {
    argv: ['claude', '-p', diagnosticText, '--resume', sessionId, '--output-format', 'json',
      '--setting-sources', '',
      '--settings', settingsPath, '--permission-mode', 'acceptEdits',
      '--max-turns', String(effectiveMaxTurns(budget))],
    settingsPath, cwd, env_names: [],
  };
}

const DIGEST = /^[0-9a-f]{64}$/;

// `2.1.225`、`2.1.223 (Claude Code)`、带前导空白或换行的 --version 原样输出都要能解析；取不到三段
// 数字返回 null。launch.mjs 的采集器在 --version 输出不含三段数字时也给 null，两边同形。
function parseVersion(value) {
  const match = typeof value === 'string' ? /^\s*v?(\d+)\.(\d+)\.(\d+)\b/.exec(value) : null;
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

// 逐段数值比较。字符串字典序在这里是错的：它会把 2.1.9 判成不低于 2.1.223、把 2.1.1000 判成更旧。
function versionFloorReason(claudeVersion) {
  const actual = parseVersion(claudeVersion);
  // 解析不出来 = 未知形态，不是放行理由（fail closed）。
  if (actual === null) {
    return `claude version is unreadable, so the ${CLAUDE_VERSION_FLOOR} minimum cannot be verified`;
  }
  const floor = parseVersion(CLAUDE_VERSION_FLOOR);
  for (let i = 0; i < 3; i += 1) {
    if (actual[i] !== floor[i]) {
      return actual[i] < floor[i]
        ? `claude version is older than the tested minimum: at least ${CLAUDE_VERSION_FLOOR} is required`
        : null;
    }
  }
  return null;
}

function settingsContainKey(value, forbidden) {
  if (value === null || typeof value !== 'object') return false;
  return Object.keys(value).some((key) => forbidden.includes(key))
    || Object.values(value).some((child) => settingsContainKey(child, forbidden));
}

// contract 参与判定的部分只有 constraints 的 physical 核验（见下）；hash 与 binding 的核验在
// workflow.mjs binding 层。
export function assertLaunchable(contract, probes) {
  const reasons = [];
  if (!DIGEST.test(probes?.contractHash ?? '')) reasons.push('contractHash must be lowercase SHA-256');
  if (probes?.confirmedHash !== probes?.contractHash) reasons.push('confirmed hash does not match contract hash');
  if (probes?.baselineDigestStored !== true) reasons.push('baseline digest is not stored in trusted orchestration state');
  if (contract?.budget?.user_provided === true
    && typeof contract.budget.max_turns === 'number'
    && contract.budget.max_turns > MAX_TURNS_CEILING) {
    reasons.push(`contract budget.max_turns exceeds the Claude hard ceiling ${MAX_TURNS_CEILING}; reduce the confirmed budget before launch`);
  }
  const versionReason = versionFloorReason(probes?.claudeVersion);
  if (versionReason !== null) reasons.push(versionReason);
  // --session-id 是恢复模型的前提（指针先于 spawn 存在）。这不是版本代理：prepare 采集
  // `claude --help` 直接探测 flag 存在性，直接检查优先于版本推断——flag 何时引入无从由版本
  // 下限证明，而它是否存在可以直接问。旧 state 目录（本探测引入之前 prepare 的）没有这个值，
  // 同样落红：重跑 prepare 即可，前置闸拒绝不烧 attempt 配额。
  if (probes?.claudeSessionIdFlag !== true) {
    reasons.push('claude --help does not advertise --session-id (or probes.json predates the '
      + 'capability probe): re-run prepare against a claude that supports controller-issued session ids');
  }
  if (probes?.claudeSettingSourcesFlag !== true) {
    reasons.push('claude --help does not advertise --setting-sources (or probes.json predates the capability '
      + 'probe): re-run prepare against a claude that can exclude ambient project and user settings');
  }
  if (settingsContainKey(probes?.settings, ['disableAllHooks', 'allowManagedHooksOnly'])) {
    reasons.push('settings must not disable or restrict hooks');
  }
  const hook = probes?.hookScript;
  const permissions = probes?.settings?.permissions ?? {};
  const deny = permissions.deny ?? [];
  // postflight argv 不进权限 DSL（V5'），因此这里没有它的投影——含括号/空格的 verifier 路径
  // 不该 false-red 一次本可正常起飞的 launch。
  const permissionInputs = [
    ...(contract?.execution_permissions?.bash_prefixes ?? []),
    ...(contract?.execution_permissions?.webfetch_domains ?? []),
    ...(contract?.execution_permissions?.skills ?? []),
    probes?.stateDir,
    hook?.path,
  ];
  if (permissionInputs.some((value) => permissionSpecifierProblem(value) !== null)) {
    reasons.push('a value entering the Claude permission specifier DSL is not representable');
  }
  if (!hook?.exists) reasons.push('hook script is not on disk in controller state');
  if (hook?.sha256 !== probes?.expectedHookSha256) reasons.push('hook script bytes do not match the generated script');
  if (hook?.mode !== '0500') reasons.push('hook script mode must be 0500');
  // 下面两条 deny 检查守的是**本文件的生成器**，不是篡改：生产路径上 probes.settings 就是
  // buildSettings 现场生成、并由 launch.mjs 覆写回磁盘的那一份（judged object = consumed object
  // 由构造保证，见 launch.mjs 的 writeReplacing(settingsPath, ...)），所以这两行在那条路径上是
  // 同义反复。它们真正拦得住的是「buildSettings 将来被改坏、少生成一条 deny」——那时 launch
  // 仍会照常起飞，只有这里能红。别把它读成防篡改闸。
  if (!deny.includes(`Edit(/${hook?.path})`)) reasons.push('settings must deny Edit on the hook script path');
  // state 目录那条护的是 hook-runs.jsonl / hook-env.json / probes.json，
  // 少了它 hook 脚本本身没被改、留痕却可以被抹掉。stateDir 缺失时拼不出规则，天然落红。
  if (!deny.includes(`Edit(/${probes?.stateDir}/**)`)) {
    reasons.push('settings must deny Edit on the whole controller state directory');
  }
  // allow/additionalDirectories 与 deny 一样属于 buildSettings 的消费面。这里独立重算期望形状，
  // 防的是生成器回归（生产路径的 settings 是现场重写，磁盘比对本身抓不到“稳定地产错”）。
  // 与 buildSettings 逐字镜像：显式 bash_prefixes → :* 前缀；postflight 不进 allow（V5'），
  // 镜像里同样没有它——两侧再无 argv 投影可分叉。
  const expectedAllow = [
    ...unique(contract?.execution_permissions?.bash_prefixes ?? []).map((prefix) => `Bash(${prefix}:*)`),
    ...(contract?.execution_permissions?.webfetch_domains ?? [])
      .map((domain) => `WebFetch(domain:${domain})`),
    ...(contract?.execution_permissions?.skills ?? []).map((skill) => `Skill(${skill})`),
  ];
  if (JSON.stringify(permissions.allow ?? null) !== JSON.stringify(expectedAllow)) {
    reasons.push('settings allow rules do not exactly match the confirmed contract');
  }
  // unique 后再 slice，与 buildSettings 的 unique(targetRoots).slice(1) 逐字同序：unique(T).slice(1)
  // ≠ unique(T.slice(1))，重复首根时两者分叉会把合法 contract 永久判红（V1，三方收敛）。
  const expectedAdditionalDirectories = unique([
    ...unique(probes?.targetRoots ?? []).slice(1),
    ...(probes?.additionalReadRoots ?? []),
  ]);
  if (JSON.stringify(permissions.additionalDirectories ?? null)
    !== JSON.stringify(expectedAdditionalDirectories)) {
    reasons.push('settings additionalDirectories do not exactly match the canonical contract roots');
  }
  // target_roots 与 additional_read_roots 都是 Claude 可达面。任何一根与 controller state 互为
  // 祖先（包括根目录 /）都会暴露 hook-env.json。用 path.relative 做 component-safe 包含判定，
  // 避免字符串 `${root}/` 在 / 上退化成 //，也避免 /foo 与 /foobar 的前缀误判。
  const containsPath = (parent, child) => {
    if (typeof parent !== 'string' || typeof child !== 'string') return false;
    const rel = relative(parent, child);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  };
  const authorizedRoots = [
    ...(probes?.targetRoots ?? []),
    ...(probes?.additionalReadRoots ?? []),
  ];
  for (const root of authorizedRoots) {
    if (containsPath(root, probes?.stateDir) || containsPath(probes?.stateDir, root)) {
      reasons.push('an authorized root overlaps the controller state directory; credentials and controller '
        + 'evidence must stay outside every Claude-accessible root');
    }
  }
  // execution_permissions 编译的是自动授权，deny 保护的是 controller 与 Claude 项目配置；两者都
  // 没有把任意业务 constraint 编译成可验证的 OS enforcement。因此 enforcement:"physical" 仍一律
  // 红——降级成 audit_only 是 contract 作者的决定，执行层只负责停车。曾经的判据是「mechanism
  // 必须逐字点名一条生成的 deny 规则」：行为同样是红，但诊断在骗人——它读起来像「改 mechanism
  // 就能过」，而 controller deny 含 contractHash/stateRoot/controller，把它写进 contract 会改 hash，
  // 是不动点陷阱。故 reason 直说真因，且刻意不提 mechanism（N1）。
  for (const constraint of contract?.constraints ?? []) {
    if (constraint?.enforcement !== 'physical') continue;
    reasons.push(`constraint ${constraint.id ?? '?'} declares physical enforcement, which the claude `
      + 'runtime cannot support: execution permissions authorize tools and generated deny rules protect '
      + 'controller or Claude settings, but arbitrary user-facing constraints have no physical compiler; '
      + 'rewrite the constraint as audit_only');
  }
  return { ok: reasons.length === 0, reasons };
}
