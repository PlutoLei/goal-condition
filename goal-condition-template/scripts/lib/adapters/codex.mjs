// Codex runtime adapter：纯函数 + GoalRpcClient（唯一执行豁口，Task 6）。
// 全部形状来自 2026-08-06 spike 实测（codex-cli 0.146.0-alpha.9.2）。

import { spawn } from 'node:child_process';

import { isTemporaryPath } from '../contract.mjs';

export const GOAL_ENVELOPE_REQUIRED_KEYS = Object.freeze([
  'createdAt', 'objective', 'status', 'threadId', 'timeUsedSeconds', 'tokensUsed', 'updatedAt',
]);
export const GOAL_ENVELOPE_OPTIONAL_KEYS = Object.freeze(['tokenBudget']);
// RPC 层实测词形是 camelCase（S2b: "budgetLimited"）；sqlite 层 snake_case 不出现在本层。
export const GOAL_STATUSES = Object.freeze([
  'active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete',
]);
// S2 实测的真实通知 method 全集；turn 边界只认精确 method 名，不用宽泛正则。
export const NOTIFICATION_METHODS = Object.freeze([
  'thread/started', 'mcpServer/startupStatus/updated', 'thread/goal/updated', 'thread/status/changed',
  'turn/started', 'item/started', 'item/completed', 'item/agentMessage/delta',
  'turn/diff/updated', 'thread/tokenUsage/updated', 'account/rateLimits/updated', 'turn/completed',
]);
export const TURN_BOUNDARY_METHODS = Object.freeze(['turn/started', 'turn/completed']);

// 通知落盘 / 进终局报告的收敛规则（纯函数，method 名与 payload 形状的唯一真值源）。
// 起因（N-5）：`account/rateLimits/updated` 在上面的 NOTIFICATION_METHODS 里列着，实际却一个字
// 都没落盘——onEnvelope 只写 request/response，通知只喂 _notifyCbs 而那里只统计两个 turn method。
// 后果是终局报告只说得出 "goal reached usageLimited"，说不出「credits 余额 0、8 月 12 日重置」，
// 而 `close` 会把唯一存着该信息的隔离 codexHome 连 rollout 日志一起删掉：按正常流程（撞限流 →
// 报告 → close 收尾）操作，成因就永久丢失。
// 只收两类：
// - `account/rateLimits/updated`：限流成因的唯一信号。
// - `turn/completed`：只在带 error 体时收——不带 error 的 turn 已经由 turn-counts.json 计过数。
// 其余一律不收。`item/agentMessage/delta` 逐 token 触发、`turn/diff/updated` 携带工作树 diff 全文，
// 它们是执行体产出的**内容**，不是控制器判定所需的事实；同步 append 到证据文件还会把日志撑爆。
// payload 一律序列化后截断到 NOTIFICATION_PAYLOAD_CAP：通知形状随 alpha 漂移，钉死字段路径会漏；
// 原样落盘又等于把任意大小的执行体内容写进证据通道。
export const NOTIFICATION_PAYLOAD_CAP = 2000;

function capJson(value) {
  const text = JSON.stringify(value ?? null) ?? 'null';
  if (text.length <= NOTIFICATION_PAYLOAD_CAP) return text;
  return `${text.slice(0, NOTIFICATION_PAYLOAD_CAP)}…[truncated ${text.length - NOTIFICATION_PAYLOAD_CAP} chars]`;
}

export function noteworthyNotification({ method, params } = {}) {
  if (method === 'account/rateLimits/updated') {
    return { record: true, method, payload: capJson(params?.rate_limits ?? params?.rateLimits ?? params ?? null) };
  }
  if (method === 'turn/completed') {
    const error = params?.error ?? params?.turn?.error;
    if (error === undefined || error === null) return { record: false };
    return { record: true, method, payload: capJson(error) };
  }
  return { record: false };
}

const ALLOWED_KEYS = new Set([...GOAL_ENVELOPE_REQUIRED_KEYS, ...GOAL_ENVELOPE_OPTIONAL_KEYS]);

export function validateGoalEnvelope(goal) {
  if (goal === null || typeof goal !== 'object' || Array.isArray(goal)) {
    return { ok: false, reasons: ['goal envelope must be an object'] };
  }
  const reasons = [];
  const missing = GOAL_ENVELOPE_REQUIRED_KEYS.filter((key) => !Object.hasOwn(goal, key));
  const unknown = Object.keys(goal).filter((key) => !ALLOWED_KEYS.has(key));
  if (missing.length) reasons.push(`goal envelope is missing ${missing.length} required key(s)`);
  if (unknown.length) reasons.push(`goal envelope contains ${unknown.length} unknown key(s)`);
  if (!GOAL_STATUSES.includes(goal.status)) reasons.push('goal status is not a known status');
  return { ok: reasons.length === 0, reasons };
}

// §4 六态逐态处置表。paused/usageLimited 不自动 resume（自动 resume=绕限流，触「无人值守禁旁路」铁律）；
// budgetLimited 抬预算须经用户确认（预算仅用户明给）。
export function goalDisposition(status) {
  if (status === 'active') return { next: 'poll' };
  if (status === 'complete') {
    return { next: 'candidate', candidate: { status: 'ready_for_postflight', remaining_work: false } };
  }
  if (['blocked', 'paused', 'usageLimited', 'budgetLimited'].includes(status)) {
    return { next: 'terminal_report', autoResume: false, status };
  }
  return { next: 'reject' };
}

export function normalizeTerminal(goal) {
  const shape = validateGoalEnvelope(goal);
  if (!shape.ok) return { kind: 'reject', reasons: shape.reasons };
  const disposition = goalDisposition(goal.status);
  if (disposition.next === 'candidate') return { kind: 'candidate', candidate: disposition.candidate };
  if (disposition.next === 'poll') return { kind: 'poll' };
  if (disposition.next === 'terminal_report') {
    return { kind: 'terminal_report', status: goal.status, reasons: [`goal reached ${goal.status}`] };
  }
  return { kind: 'reject', reasons: ['goal status is not a known status'] };
}

export function assertSetReturnedStatus(setEnvelope, expected) {
  const goal = setEnvelope?.result?.goal;
  const shape = validateGoalEnvelope(goal);
  if (!shape.ok) return { ok: false, observed: null, reasons: shape.reasons };
  if (goal.status !== expected) {
    return { ok: false, observed: goal.status, reasons: [`set returned status ${goal.status}, expected ${expected}`] };
  }
  return { ok: true, observed: goal.status, reasons: [] };
}

// 单次 rpc 的超时上限。导出是因为它与 launch.mjs 的 LEASE_TTL_MS 有一条必须成文的关系：
// 心跳只在轮询每拍与连接阶段各刷一次，两次刷新之间最长可达 pollInterval + 本常量，**远超**
// 30s 的租约 TTL。所以「心跳过期」不足以断言持有者死了（review M-3）。
export const RPC_TIMEOUT_MS = 60_000;

const DIGEST = /^[0-9a-f]{64}$/;
// launch.mjs 的 GoalRpcClient.threadStart 把 sandbox 钉死在这个值（S6 finalize receipt 可信的前提）。
export const CODEX_SANDBOX_MODE = 'workspace-write';
export const CODEX_READ_ONLY_SANDBOX_MODE = 'read-only';
// 同一个沙箱模式在协议两侧是两个词形：请求参数写 kebab 的 `workspace-write`（上面那个常量），
// 响应体里的 `sandbox.type` 回的是 camel 的 `workspaceWrite`（0.147.0-alpha.6.5 实测，`thread/start`
// 与 `thread/resume` 的 config 块逐字一致）。两个都得存在——拿请求词形去比响应会永远红。
export const CODEX_SANDBOX_TYPE = 'workspaceWrite';
export const CODEX_READ_ONLY_SANDBOX_TYPE = 'readOnly';

// `thread/start` 产出的沙箱块的逐字形态（同一次实测，start 与 resume 两侧的 config 块相同）。
// 续跑校验比的是**整块**而不是 `type` 一个字段：同 type 而可写面被放大的沙箱（`writableRoots` 多出
// 一项、`networkAccess` 翻真）照样是另一个沙箱，而 resume 侧控制器什么都没设、什么都不知道，只读一个
// 字段等于把其余四个交给信任。
// 闭世界（未知字段即红），与 validateGoalEnvelope 同一姿态：沙箱块将来多一个旋钮时本闸会红——那正是
// 要人看一眼的时刻，新旋钮的语义只有人能判，控制器不该替它猜一个默认。
// 两个 `exclude*` 记的是 launch 那一刻的事实（`false` = `$TMPDIR` 与 `/tmp` 未被排除在可写面外），
// 钉的是**连续性**而不是「要求这两处可写」：与 launch profile 不一致的续跑，无论松紧，都不是同一个沙箱。
export const CODEX_SANDBOX_PROFILE = Object.freeze({
  type: CODEX_SANDBOX_TYPE,
  writableRoots: Object.freeze([]),
  networkAccess: false,
  excludeTmpdirEnvVar: false,
  excludeSlashTmp: false,
});
export const CODEX_READ_ONLY_SANDBOX_PROFILE = Object.freeze({
  type: CODEX_READ_ONLY_SANDBOX_TYPE,
  networkAccess: false,
});

// prepare 的探测失败会把 `probe failed: …` 原样写进 probes.codexVersionRaw。它非空，所以只判
// 「非空字符串」的旧闸让「codex 根本没装 / PATH 不通」也一路绿灯进到 auth-copy（F-2 附带）。
// 改判「解析得出版本号形态」，与 claude 侧先从 --version 输出里 match 出 x.y.z 再判定同构。
// codex 侧不配 allowlist：实测形态是 `codex-cli 0.147.0-alpha.1.2`，alpha 序列还在快速变形，
// 钉死单一版本会天天红；本闸只保证「探测真的拿到了一个版本」，不保证是哪一个。
const CODEX_VERSION = /\b\d+\.\d+\.\d+/;
const PROBE_FAILED_PREFIX = 'probe failed:';

export function parseCodexVersion(codexVersionRaw) {
  if (typeof codexVersionRaw !== 'string') return null;
  // 前缀独立判一次：失败文本里可能夹带任意内容（命令行、路径、上游版本号），不能让它凑巧
  // match 出一个版本号形态就把红判成绿。
  if (codexVersionRaw.trimStart().startsWith(PROBE_FAILED_PREFIX)) return null;
  const match = codexVersionRaw.match(CODEX_VERSION);
  return match ? match[0] : null;
}

// state 目录的位置判定：它必须在执行体可写面之外。
//
// 起因：state 目录里住着**全部** controller-owned 证据——finalize receipt、runtime readback、
// goal-set ledger、thread 坐标、按 attempt 归档的候选。执行体若能写这个目录，codex 线的整个证据
// 模型都不成立。这条前提此前从未被写下来，也从未被核过，而 adapter 又在它之上建了新的安全判定
// （finalize 的陈旧候选闸读的就是 state 目录里的一个文件）。
//
// 两条判据，都指向同一件事「执行体写得到吗」：
// - 落在任一 `target_roots` 之内：那是 `--sandbox workspace-write` 明确授权可写的地方。
// - 落在临时目录内：实测沙箱块的 `excludeSlashTmp` 与 `excludeTmpdirEnvVar` 都是 `false`，
//   即 `/tmp` 与 `$TMPDIR` 同样在执行体可写面内。判据有两条，缺一不可：`isTemporaryPath`（与
//   contract 校验共用的那条，认标准位置）+ 采集层传进来的**本次运行实际生效的** `$TMPDIR`——
//   前者认不出被改过的 TMPDIR，后者认不出「TMPDIR 没被改但路径写的是 /tmp」。
// 这不是「整个证据模型的可信度」那个更大的问题的解——它只保证控制器自己不主动把证据放进执行体
// 够得着的地方。
// targetRoots 取自 probes 而不是 contract：路径比较前两侧都要归一，归一是采集层的活（与 claude 侧
// assertLaunchable 读 probes.targetRoots 同一条约定）。
function stateDirReasons(targetRoots, stateDir, temporaryRoot) {
  const next = 'next=re-run `prepare` with a --state-root outside every target root and outside the '
    + 'temporary directories the sandbox leaves writable';
  if (typeof stateDir !== 'string' || stateDir.length === 0) {
    return [`the controller state directory was not collected, so it cannot be shown to sit outside the executor's writable surface: ${next}`];
  }
  const reasons = [];
  // 元素类型与「非数组 / 空集」同判（口径取自兄弟闸 assertResumedSession）：`[42]` / `[null]` 这类
  // 采集残骸做不了路径比较，下面那个 filter 会把它们整个滤掉，于是「比不了」又变回「没命中」。
  if (!Array.isArray(targetRoots) || targetRoots.length === 0
    || targetRoots.some((root) => typeof root !== 'string')) {
    reasons.push('the contract target roots were not collected as a list of paths, so the controller state '
      + `directory cannot be shown to sit outside the executor's writable surface: ${next}`);
  }
  const inside = (Array.isArray(targetRoots) ? targetRoots : []).filter((root) => (
    typeof root === 'string' && (stateDir === root || stateDir.startsWith(`${root}/`))
  ));
  if (inside.length) {
    reasons.push('the controller state directory sits inside a contract target root, which is exactly '
      + `what --sandbox workspace-write authorises the executor to write: ${next}`);
  }
  const underTemporaryRoot = typeof temporaryRoot === 'string' && temporaryRoot.length > 0
    && (stateDir === temporaryRoot || stateDir.startsWith(`${temporaryRoot}/`));
  if (isTemporaryPath(stateDir) || underTemporaryRoot) {
    reasons.push('the controller state directory sits in a temporary directory, and the sandbox this '
      + 'adapter pins leaves /tmp and $TMPDIR writable (excludeSlashTmp and excludeTmpdirEnvVar are '
      + `both false): ${next}`);
  }
  return reasons;
}

// launch 前置判定（纯函数，只判不采；probes 由 launch.mjs 事先采集/合成并落盘）。通用两项
// （confirmedHash/baselineDigestStored）与 claude 侧同构；codex 专属三项：版本已采集、实际沙箱模式
// 与 contract 声明的 physical sandbox 机制逐条对应、state 目录无任何残留租约——'live' 是上次
// launch 还活着（不允许并发起第二个），'stale' 是持有者已失联但它起的 daemon/goal 可能仍在
// （租约到期不触发任何 clear，见 codex.md「生命周期」），两者都拦，后者的出口是先跑 close。
export function assertLaunchable(contract, probes) {
  const reasons = [];
  if (!DIGEST.test(probes?.contractHash ?? '')) reasons.push('contractHash must be lowercase SHA-256');
  if (probes?.confirmedHash !== probes?.contractHash) reasons.push('confirmed hash does not match contract hash');
  if (probes?.baselineDigestStored !== true) reasons.push('baseline digest is not stored in trusted orchestration state');
  if (parseCodexVersion(probes?.codexVersionRaw) === null) {
    reasons.push('codex version has not been collected: prepare could not read a version out of '
      + '`codex --version` (install codex or fix PATH so the launcher can find it, then re-run prepare)');
  }
  const expectedSandboxMode = probes?.expectedSandboxMode ?? CODEX_SANDBOX_MODE;
  if (![CODEX_SANDBOX_MODE, CODEX_READ_ONLY_SANDBOX_MODE].includes(expectedSandboxMode)) {
    reasons.push('expected sandbox mode is not a controller-supported mode');
  } else if (probes?.sandboxMode !== expectedSandboxMode) {
    reasons.push(`sandbox mode must be ${expectedSandboxMode}`);
  }
  reasons.push(...stateDirReasons(probes?.targetRoots, probes?.stateDir, probes?.temporaryRoot));
  // spec §5 的「逐条对应」指每一条 physical 约束，不是「每一条提到 sandbox 的」。此前不提
  // sandbox 的 mechanism（proxy、只读凭证）与缺失 mechanism 都被 continue 放过，等于 physical
  // 声明零核验（fail-open）。本 adapter 唯一的物理面是 threadStart 钉死的 --sandbox 模式，
  // 别的机制 controller 侧看不见也验不了，只能红——降级成 audit_only 是 contract 作者的决定。
  for (const constraint of contract?.constraints ?? []) {
    if (constraint?.enforcement !== 'physical') continue;
    const mechanism = typeof constraint.mechanism === 'string' ? constraint.mechanism : '';
    if (!mechanism.includes('sandbox')) {
      reasons.push(`constraint ${constraint.id ?? '?'} claims physical enforcement, but this adapter's `
        + 'only physical surface is --sandbox: mechanisms such as an egress proxy or read-only '
        + 'credentials cannot be verified controller-side, so rewrite the constraint as audit_only');
    } else if (!mechanism.includes(probes?.sandboxMode)) {
      reasons.push(`constraint ${constraint.id ?? '?'} declares a sandbox mechanism that does not match the actual sandbox mode`);
    }
  }
  if (probes?.leaseResidue === 'live') {
    reasons.push('a live lease.json already exists in the state directory');
  } else if (probes?.leaseResidue !== 'none') {
    // 'stale'、未知词形与缺失一律走这条：未知即 fail-closed，不猜「大概是没有残留」。
    // next= 是 N-2 补的：这条诊断此前只说「run close」，而 close 的第一件事是读 codex-home.path，
    // 读不到就直接 return——launch 说跑 close、close 说没什么可关，两句话互相指认而磁盘一动不动。
    // close 已改成无论有没有 codexHome 都释放残留租约，出路因此写得实：跑 close，跑完还在就说明
    // 它是别的活 run 的租约。
    reasons.push('a residual lease.json remains in the state directory: '
      + 'next=run `close` on this state dir to release it (close now releases a residual lease even when '
      + 'there is no codex-home.path left to clean up); if close reports the lease still belongs to a live '
      + 'run, confirm that run is really gone, or start fresh under a different --controller name');
  }
  return { ok: reasons.length === 0, reasons };
}

// 沙箱块与 launch profile 的逐字比对。每条 reason 点名是哪个字段——「沙箱不对」不足以让操作员
// 判断该不该放行，可写面多一个根与网络被打开是两件不同的事。
function sandboxDrift(sandbox) {
  const prefix = "the resumed session's sandbox differs from the one this run launched under: ";
  if (sandbox === null || typeof sandbox !== 'object' || Array.isArray(sandbox)) {
    return [`${prefix}thread/resume returned no sandbox block to verify`];
  }
  const reasons = [];
  const fields = Object.keys(CODEX_SANDBOX_PROFILE);
  const unknown = Object.keys(sandbox).filter((key) => !fields.includes(key));
  if (unknown.length) {
    reasons.push(`the sandbox block carries ${unknown.length} field(s) this adapter has never verified, `
      + `starting with ${capJson(unknown[0])}: a new sandbox knob is a human's call, not a default to guess`);
  }
  for (const field of fields) {
    if (!Object.hasOwn(sandbox, field)) {
      reasons.push(`the sandbox block is missing ${field}`);
    } else if (field === 'writableRoots') {
      if (!Array.isArray(sandbox.writableRoots)) reasons.push('writableRoots is not an array');
      else if (sandbox.writableRoots.length > 0) {
        reasons.push(`the sandbox grants ${sandbox.writableRoots.length} writable root(s) beyond the launch `
          + `profile, starting with ${capJson(sandbox.writableRoots[0])}`);
      }
    } else if (sandbox[field] !== CODEX_SANDBOX_PROFILE[field]) {
      reasons.push(`${field} is ${capJson(sandbox[field])}, expected ${capJson(CODEX_SANDBOX_PROFILE[field])}`);
    }
  }
  return reasons.map((reason) => `${prefix}${reason}`);
}

// 续跑的会话连续性判定（纯函数；观测值由 launch.mjs 从 `thread/resume` 响应里采集、路径归一后传入）。
//
// 起因是续跑路径上的一个信任缺口：本 adapter 声称「唯一可核的物理面是 `thread/start` 钉死的
// `--sandbox workspace-write`」，而这句话在 launch 上靠的是**请求参数**，在 resume 上没有任何对应
// 动作——`thread/resume` 只传 `{threadId}`，沙箱由服务端从持久化的 thread 状态恢复，控制器既不指定
// 也不校验。实测那个返回体里装着整个会话配置（`sandbox`/`cwd`/`runtimeWorkspaceRoots`/`model`/
// `approvalPolicy`/`activePermissionProfile`），读回来比一遍，这句声明在续跑上才有观测支撑。
//
// 只比三项：沙箱块（整块逐字，见 sandboxDrift）、cwd、可写工作区根。
// `approvalPolicy` 与 `activePermissionProfile` **不比**——
// 实测它们在 start/resume 之间本来就不逐字相等（`activePermissionProfile` 从 `null` 变成
// `{"id":":workspace","extends":null}`），拿它们当判据会把一次正常续跑判红。
// 字段缺失、类型不符一律红：协议漂移掉了这几个字段时，「核不了」不等于「核过了」（fail-closed）。
export function assertResumedSession({ observed, threadId, targetRoots }) {
  const reasons = [];
  if (observed === null || typeof observed !== 'object' || Array.isArray(observed)) {
    return { ok: false, reasons: ['thread/resume returned no session configuration to verify'] };
  }
  if (!Array.isArray(targetRoots) || targetRoots.length === 0 || targetRoots.some((root) => typeof root !== 'string')) {
    return { ok: false, reasons: ['contract target_roots are unusable, so the resumed session cannot be verified'] };
  }
  if (observed.threadId !== threadId) {
    reasons.push(`thread/resume returned a different thread than the one this run launched: ${capJson(observed.threadId)}`);
  }
  reasons.push(...sandboxDrift(observed.sandbox));
  if (observed.cwd !== targetRoots[0]) {
    reasons.push(`the resumed session works out of ${capJson(observed.cwd)}, not the contract target root `
      + 'this run launched under');
  }
  if (!Array.isArray(observed.workspaceRoots) || observed.workspaceRoots.length === 0) {
    reasons.push('thread/resume reported no runtime workspace roots to check against the contract target roots');
  } else {
    const outside = observed.workspaceRoots.filter((root) => !targetRoots.includes(root));
    if (outside.length) {
      reasons.push(`the resumed session carries ${outside.length} writable workspace root(s) outside the `
        + `contract target roots, starting with ${capJson(outside[0])}`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}

// S4 实测：inject 只把内容追加进模型可见历史、不驱动执行；goal 不再自动续轮时必须配显式 turn/start。
export function resumeRpcOps({ threadId, diagnosticText, tokenBudget }) {
  const setParams = tokenBudget === undefined
    ? { threadId, status: 'active' }
    : { threadId, status: 'active', tokenBudget };
  return [
    { method: 'thread/goal/set', params: setParams, expectStatus: 'active' },
    {
      method: 'thread/inject_items',
      params: {
        threadId,
        items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: diagnosticText }] }],
      },
    },
    {
      method: 'turn/start',
      params: {
        threadId,
        input: [{
          type: 'text',
          text: 'Address the injected postflight diagnostic above, then continue toward the goal objective.',
        }],
      },
    },
  ];
}

// §3 D5：goal_id RPC 层不可得、updatedAt 秒级会撞值 → threadId+updatedAt+控制器单调序列号三重归因。
export function verifyFinalizeAttribution({ setEnvelope, readbackEnvelope, threadId, sequence, ledger }) {
  const reasons = [];
  const setGoal = setEnvelope?.result?.goal;
  const readGoal = readbackEnvelope?.result?.goal;
  for (const [name, goal] of [['set', setGoal], ['readback', readGoal]]) {
    const shape = validateGoalEnvelope(goal);
    if (!shape.ok) reasons.push(`${name} envelope is invalid`);
  }
  if (reasons.length) return { ok: false, reasons };
  if (setGoal.threadId !== threadId || readGoal.threadId !== threadId) reasons.push('threadId attribution mismatch');
  if (setGoal.status !== 'complete') reasons.push('set envelope status is not complete');
  if (readGoal.status !== 'complete') reasons.push('readback status is not complete');
  if (readGoal.updatedAt !== setGoal.updatedAt) reasons.push('updatedAt does not bind readback to the finalize set');
  if (!Array.isArray(ledger) || ledger.length === 0) reasons.push('goal-set ledger is empty');
  else {
    const monotonic = ledger.every((entry, index) => entry.sequence === index + 1);
    const last = ledger[ledger.length - 1];
    if (!monotonic) reasons.push('goal-set ledger sequence is not strictly monotonic');
    if (last.sequence !== sequence) reasons.push('finalize sequence does not match the last ledger entry');
    if (last.requestedStatus !== 'complete') reasons.push('last ledger entry did not request complete');
    if (last.threadId !== threadId) reasons.push('ledger threadId mismatch');
  }
  return { ok: reasons.length === 0, reasons };
}

// GoalRpcClient：controller 独占的 codex app-server 执行豁口（移植自
// spikes/goal-runtime-adapters-v2/lib/appserver-client.mjs，逐条保留实测修正）。
// goalRpc 只有主会话调用；其 envelope 是 finalize receipt / readback 的唯一合法来源——
// 执行器（turn 内产出）的输出不得反序列化为任何 controller 证据。
export class GoalRpcClient {
  constructor({
    codexHome, cwd, spawnImpl = spawn, onEnvelope, onChildFailure,
  } = {}) {
    this.codexHome = codexHome;
    this.cwd = cwd;
    this.spawnImpl = spawnImpl;
    this.onEnvelope = onEnvelope;
    // 子进程层面的失败（起不来 / 起来之后死掉）从这条通道出去。它没有 RPC 响应可挂，此前
    // 一个字都不留：'error' 被 start() 的常驻监听器无声吞掉、'exit' 根本没人听（review m-3）。
    this.onChildFailure = onChildFailure;
    this._id = 0;
    this._pending = new Map();     // id -> {resolve, reject, timer}
    this._notifyCbs = [];
    this._buf = '';
    this._childFailure = null;
  }

  // 从 _pending 摘掉一格并清掉它的超时 timer。清 timer 是 M-1 的根因修：此前 _wire 收到响应只做
  // resolve + delete，留下的悬空 timer 得靠 rpc() 里的 .unref() 兜住——而 .unref() 连**真正在飞**
  // 的那次 rpc 也一并不再撑住事件循环。于是 app-server 中途死掉、且此刻恰好没有别的 handle 时，
  // 事件循环直接排空，Node 静默退出，finally 一行不跑、四路进程级兜底一个都不响，生产凭证副本
  // 留在盘上（实测 exit 13、stdout 全空）。清了 timer，它就不必再 unref，两个问题一并消掉。
  _settle(id) {
    const entry = this._pending.get(id);
    if (!entry) return null;
    clearTimeout(entry.timer);
    this._pending.delete(id);
    return entry;
  }

  // 子进程失败归一：记下成因、让所有在飞的 rpc 如实失败、留痕。只认第一次——后续的 'exit'
  // 不得把真正的成因（'error' 里那条）覆盖成一句更笼统的话。
  //
  // 「settle 排在留痕前面」与「留痕包 try/catch」堵的是同一条路上的两段，缺一不可（f-1）：
  // 留痕排在前面时，它一抛就跳过 settle，在飞的 rpc 谁也不 settle；即便排到后面，抛出去的东西
  // 仍会**逃出监听器**——本方法两个 notify 生效的调用点都在裸 EventEmitter 监听器里
  // （proc.on('error') / proc.on('exit')），栈上没有任何 catch，而生产的 onChildFailure 是一句
  // 无保护的 appendFileSync（launch.mjs）。逃出去就是 uncaughtException → 进程级兜底
  // process.exit(1)，而 reject() 只是把 rejection 排进微任务队列：进程先死，continuation 一次都
  // 跑不到，终局报告写不出来（realrun review 发现 1 实测：退出码 1、报告体全无）。
  // 留痕是尽力而为的旁路，它自己坏了不得把「让在飞的 rpc 如实失败」这件本职带走。抛出的东西
  // 在这里咽掉：坏掉的正是留痕通道本身，没有第二个地方能写它；真正的成因不依赖它，随 rejection
  // 一路走到终局报告。
  _failPending(error, { notify = true } = {}) {
    if (this._childFailure) return;
    this._childFailure = error;
    for (const id of [...this._pending.keys()]) {
      this._settle(id)?.reject(error);
    }
    if (notify) {
      try {
        this.onChildFailure?.(error);
      } catch { /* 见上：留痕通道自己坏掉不得压过它要留的那条成因 */ }
    }
  }

  _wire(readable, writable) {
    this._writable = writable;
    readable.setEncoding('utf8');
    readable.on('data', (chunk) => {
      this._buf += chunk;
      let nl;
      while ((nl = this._buf.indexOf('\n')) >= 0) {
        const line = this._buf.slice(0, nl).trim();
        this._buf = this._buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== undefined && this._pending.has(msg.id)) {
          this.onEnvelope?.({ direction: 'response', envelope: msg });
          this._settle(msg.id).resolve(msg);
        } else if (msg.method) {
          for (const cb of this._notifyCbs) cb({ method: msg.method, params: msg.params });
        }
      }
    });
  }

  async start() {
    // 隔离铁律：codexHome 是硬约束，缺省不得静默继承 ambient/生产 CODEX_HOME（很可能是生产 ~/.codex）。
    if (!this.codexHome) {
      throw new Error('CODEX_HOME isolation is mandatory: refusing to start app-server without an explicit codexHome');
    }
    const env = { ...process.env, CODEX_HOME: this.codexHome };
    // --listen stdio:// 是默认值，显式写防未来默认漂移（实测 0.146 help 确认）。
    const proc = this.spawnImpl('codex', ['app-server', '--listen', 'stdio://'],
      { cwd: this.cwd, env, stdio: ['pipe', 'pipe', 'inherit'] });
    this._proc = proc;
    // spawn 失败（codex 不在 PATH / cwd 不存在都是 ENOENT，二进制不可执行是 EACCES）**不从
    // spawn() 同步抛出**，而是异步从子进程的 'error' 事件抛出。不注册监听器时 Node 把它升级成
    // 未捕获异常：此刻 start() 早已正常返回、调用方的 try/finally 早已出作用域，cleanup 一次都
    // 不跑，生产 auth.json 的字节级副本就留在隔离 CODEX_HOME 里（codex runtime 首次真实冒烟
    // N-1 实测：stdout 全空、EXIT=1、4354 字节的 OAuth token 副本留在盘上）。注册后归一成本方法
    // 的 rejection，落回 withCodexClient 的连接阶段路径（CodexConnectError：不占号、删掉从未连上
    // 的 codexHome、不写 codex-home.path、reason 如实说明工作目录未被触碰）。
    // 监听器常驻不摘：start() 之后才到的 'error' 同样不得变成未捕获异常。它不再被无声吞掉——
    // 走 _failPending 留痕，并让在飞的（以及随后的）rpc 以这条真成因失败（review m-3）。
    let failStart;
    const failed = new Promise((_, reject) => { failStart = reject; });
    // 竞速结束之后才到的 'error' 没有消费者——catch 掉，免得它自己变成一条 unhandledRejection。
    failed.catch(() => {});
    proc.on('error', (error) => {
      failStart(error);            // 连接阶段的竞速用（只有第一次调用有效）
      this._failPending(error);    // start() 之后才到的：留痕并让在飞的 rpc 如实失败，不再无声吞掉
    });
    // 'error' 只覆盖「子进程根本没起来」。**起来之后死掉**走的是 'exit'——那一刻没有异常、没有
    // 信号，进程级的四路兜底一个都不响；在飞的 rpc 又曾因超时 timer 被 .unref() 而不撑住事件
    // 循环，于是 Node 把事件循环走空、静默退出（M-1）。而「app-server 中途死掉」恰恰是本 adapter
    // 明确声称要处理的场景。所以子进程退出必须与 'error' 走同一条出口：归一成可等待的 rejection。
    proc.on('exit', (code, signal) => {
      this._failPending(new Error(
        `codex app-server exited before the run finished (code=${code}, signal=${signal})`));
    });
    this._wire(proc.stdout, proc.stdin);
    // 'spawn' 是 Node 对「子进程真的起来了」的唯一正信号，与 'error' 二者必有其一先到。
    await Promise.race([new Promise((resolve) => { proc.once('spawn', resolve); }), failed]);
  }

  rpc(method, params = {}) {
    // 子进程已经死了就不必再往一个死管道上写、也不必等满 60s：直接以如实的成因失败。两拍轮询
    // 之间 app-server 死掉时，这是唯一说得出「app-server 退出了」的地方——超时那条只会说
    // `RPC timeout: thread/goal/get`，与本仓「reason 如实」的标准有落差（review m-3）。
    if (this._childFailure) return Promise.reject(this._childFailure);
    const id = ++this._id;
    const envelope = { jsonrpc: '2.0', id, method, params };
    const line = JSON.stringify(envelope) + '\n';
    return new Promise((resolve, reject) => {
      // timer 不再 .unref()：真正在飞的 rpc 必须撑住事件循环（M-1 根因）。它由 _settle 在响应、
      // 超时、子进程失败、stop 四条出口上一并清掉，因此不会有悬空 timer 把进程多挂 60s——
      // 那正是当初加 .unref() 要解决的问题。
      const timer = setTimeout(() => {
        if (this._settle(id)) reject(new Error(`RPC timeout: ${method}`));
      }, RPC_TIMEOUT_MS);
      this._pending.set(id, { resolve, reject, timer });
      try {
        this.onEnvelope?.({ direction: 'request', envelope });
        this._writable.write(line);
      } catch (error) {
        // 写不出去（管道已毁、_wire 没跑过）也必须 settle：timer 现在是 ref 住的，漏掉一格就是
        // 把进程白挂 60s。
        this._settle(id);
        reject(error);
      }
    });
  }

  onNotification(cb) { this._notifyCbs.push(cb); }

  async initialize() {
    // clientInfo 为必填（schema InitializeParams.required = ["clientInfo"]）。
    const r = await this.rpc('initialize', { clientInfo: { name: 'goal-condition-launch', version: '1' } });
    return r.result ?? r;
  }

  async threadStart(params = {}) {
    // ephemeral:false 钉在展开之后——调用方传 ephemeral:true 也会被钉回 false
    // （goal 必须挂非 ephemeral thread，S1a 实测挂 ephemeral thread 拒 -32600）。
    const r = await this.rpc('thread/start', { sandbox: 'workspace-write', cwd: this.cwd, ...params, ephemeral: false });
    // threadId 在 result.thread.id（schema Thread 无 threadId 字段，只有 id）。
    const threadId = r.result?.thread?.id;
    if (!threadId) throw new Error('thread/start returned no threadId: ' + JSON.stringify(r));
    return { threadId, raw: r };
  }

  threadResume({ threadId }) {
    return this.rpc('thread/resume', { threadId });
  }

  threadRead({ threadId, includeTurns = true }) {
    return this.rpc('thread/read', { threadId, includeTurns });
  }

  turnStart({ threadId, text }) {
    return this.rpc('turn/start', { threadId, input: [{ type: 'text', text }] });
  }

  goalSet(params) {
    return this.rpc('thread/goal/set', params);
  }

  goalGet({ threadId }) {
    return this.rpc('thread/goal/get', { threadId });
  }

  goalClear({ threadId }) {
    return this.rpc('thread/goal/clear', { threadId });
  }

  // 没有 injectItems 具名方法：resume 是唯一的 inject 场景，它逐 op 走 rpc(op.method, op.params)，
  // params 只有 resumeRpcOps 一处真值源。再摆一个具名封装等于把 message item 形状抄第二遍。

  async stop() {
    if (this._proc) this._proc.kill('SIGTERM');
    // 停掉之后在飞的 rpc 永远等不到响应了。不 settle 就是留一个 ref 住事件循环的 timer 白挂 60s，
    // 或者留一个永不 settle 的 await——后者正是 M-1 那条路。
    // notify:false 且**同步**跑在 kill 之后：它先把 _childFailure 立起来，随之而来的那记 'exit'
    // 因此命中同一个守卫直接返回——我们自己 kill 出来的退出不该被报成一次子进程失败。
    this._failPending(new Error('codex app-server was stopped by the controller'), { notify: false });
  }
}
