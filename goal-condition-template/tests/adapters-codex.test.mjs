import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import {
  GOAL_ENVELOPE_REQUIRED_KEYS, GOAL_STATUSES, NOTIFICATION_METHODS, TURN_BOUNDARY_METHODS,
  validateGoalEnvelope, goalDisposition, normalizeTerminal,
  assertSetReturnedStatus, assertResumedSession, resumeRpcOps, verifyFinalizeAttribution,
  GoalRpcClient, assertLaunchable, CODEX_SANDBOX_MODE, CODEX_SANDBOX_TYPE, CODEX_SANDBOX_PROFILE,
  parseCodexVersion,
  noteworthyNotification, NOTIFICATION_PAYLOAD_CAP, RPC_TIMEOUT_MS,
} from '../scripts/lib/adapters/codex.mjs';
import { runtimeTerminalState } from '../scripts/lib/workflow.mjs';
import { LEASE_TTL_MS } from '../scripts/launch.mjs';

const fixtures = JSON.parse(await readFile(new URL('./fixtures/codex-goal-envelopes.json', import.meta.url), 'utf8'));
// 按 fixture 实际结构取真实 goal 对象（写测试时核对 JSON path）：
const completeGoal = fixtures.s1a.setComplete.result.goal;

test('real measured goal envelope validates closed-world', () => {
  assert.deepEqual(validateGoalEnvelope(completeGoal), { ok: true, reasons: [] });
  assert.deepEqual([...Object.keys(completeGoal)].sort(),
    [...GOAL_ENVELOPE_REQUIRED_KEYS, 'tokenBudget'].sort());
});

test('envelope validation fails closed on unknown/missing keys and unknown status', () => {
  for (const goal of [
    null,
    { ...completeGoal, goalId: 'x' },                                  // 未知 key（goal_id RPC 层不存在）
    (() => { const c = { ...completeGoal }; delete c.updatedAt; return c; })(),
    { ...completeGoal, status: 'in_progress' },                         // 非法状态（无 in_progress）
    { ...completeGoal, status: 'budget_limited' },                      // snake_case 词形也非法
  ]) {
    assert.equal(validateGoalEnvelope(goal).ok, false);
  }
});

test('six-state disposition table matches spec section 4', () => {
  assert.equal(goalDisposition('active').next, 'poll');
  assert.deepEqual(goalDisposition('complete'),
    { next: 'candidate', candidate: { status: 'ready_for_postflight', remaining_work: false } });
  for (const status of ['blocked', 'paused', 'usageLimited', 'budgetLimited']) {
    assert.equal(goalDisposition(status).next, 'terminal_report');
    assert.equal(goalDisposition(status).autoResume, false);       // 不自动 resume（绕限流=触铁律）
  }
  assert.equal(goalDisposition('whatever').next, 'reject');
});

test('normalizeTerminal turns complete into the exact untrusted candidate', () => {
  const normalized = normalizeTerminal(completeGoal);
  assert.equal(normalized.kind, 'candidate');
  assert.deepEqual(runtimeTerminalState('codex', normalized.candidate),
    { ok: true, phase: 'ready_for_postflight', reasons: [] });
  assert.equal(normalizeTerminal({ ...completeGoal, status: 'blocked' }).kind, 'terminal_report');
  assert.equal(normalizeTerminal({ ...completeGoal, status: 'active' }).kind, 'poll');
  assert.equal(normalizeTerminal({ ...completeGoal, extra: 1 }).kind, 'reject');
});

test('notification method set is the measured set, turn boundaries exact', () => {
  assert.equal(NOTIFICATION_METHODS.length, 12);
  assert.deepEqual(TURN_BOUNDARY_METHODS, ['turn/started', 'turn/completed']);
  assert.ok(NOTIFICATION_METHODS.includes('thread/goal/updated'));
});

test('assertSetReturnedStatus reads the actual returned status', () => {
  const accepted = { result: { goal: { ...completeGoal, status: 'active' } } };
  const refused = { result: { goal: { ...completeGoal, status: 'budgetLimited' } } };
  assert.equal(assertSetReturnedStatus(accepted, 'active').ok, true);
  const verdict = assertSetReturnedStatus(refused, 'active');
  assert.equal(verdict.ok, false);
  assert.equal(verdict.observed, 'budgetLimited');
  assert.equal(assertSetReturnedStatus({ result: {} }, 'active').ok, false);
});

// 请求侧与响应侧是同一个沙箱模式的两个词形（kebab / camel），实测坐实。拿请求词形去比响应会永远红，
// 所以这两个常量必须都在、且必须不相等——写成同一个字符串就是把这条判定悄悄关掉。
test('the sandbox mode has one wire word on the request and another on the response', () => {
  assert.equal(CODEX_SANDBOX_MODE, 'workspace-write');
  assert.equal(CODEX_SANDBOX_TYPE, 'workspaceWrite');
});

test('assertResumedSession accepts the measured resume config and fails closed on every physical drift', () => {
  // 实测值（0.147.0-alpha.6.5 的 thread/resume 响应，路径已由采集层归一）。
  const green = {
    threadId: 't-1',
    sandbox: { ...CODEX_SANDBOX_PROFILE, writableRoots: [] },
    cwd: '/work/root',
    workspaceRoots: ['/work/root'],
  };
  const targetRoots = ['/work/root'];
  assert.deepEqual(assertResumedSession({ observed: green, threadId: 't-1', targetRoots }), { ok: true, reasons: [] });

  // 沙箱那几格只动一个字段：整块换掉的话 type 那条会先命中，被放大的那一格永远得不到验证。
  const sandbox = (overrides) => ({ ...green, sandbox: { ...green.sandbox, ...overrides } });
  for (const [label, observed] of [
    ['sandbox downgraded', sandbox({ type: 'dangerFullAccess' })],
    ['sandbox block gone', { ...green, sandbox: undefined }],
    ['sandbox block not an object', { ...green, sandbox: 'workspaceWrite' }],
    ['an extra writable root', sandbox({ writableRoots: ['/etc'] })],
    ['writableRoots not an array', sandbox({ writableRoots: '/etc' })],
    ['network reopened', sandbox({ networkAccess: true })],
    ['tmpdir handling changed', sandbox({ excludeTmpdirEnvVar: true })],
    ['slash-tmp handling changed', sandbox({ excludeSlashTmp: true })],
    ['a verified field missing', { ...green, sandbox: { type: 'workspaceWrite', writableRoots: [] } }],
    ['an unverified knob added', sandbox({ allowSomethingNew: true })],
    ['cwd moved', { ...green, cwd: '/somewhere/else' }],
    ['a workspace root outside the target roots', { ...green, workspaceRoots: ['/work/root', '/etc'] }],
    ['no workspace roots', { ...green, workspaceRoots: [] }],
    ['workspace roots not an array', { ...green, workspaceRoots: '/work/root' }],
    ['another thread', { ...green, threadId: 't-2' }],
  ]) {
    const verdict = assertResumedSession({ observed, threadId: 't-1', targetRoots });
    assert.equal(verdict.ok, false, label);
    assert.ok(verdict.reasons.length > 0, label);
  }

  // 观测本身取不到、或 contract 的 target_roots 不可用时同样红：核不了不等于核过了。
  for (const observed of [undefined, null, 'nope', []]) {
    assert.equal(assertResumedSession({ observed, threadId: 't-1', targetRoots }).ok, false);
  }
  for (const roots of [undefined, [], [null]]) {
    assert.equal(assertResumedSession({ observed: green, threadId: 't-1', targetRoots: roots }).ok, false);
  }
});

test('resumeRpcOps is set-active, inject message item, then explicit turn/start', () => {
  const ops = resumeRpcOps({ threadId: 't-1', diagnosticText: 'pf-test failed: exit 1' });
  assert.deepEqual(ops.map((op) => op.method), ['thread/goal/set', 'thread/inject_items', 'turn/start']);
  assert.deepEqual(ops[0].params, { threadId: 't-1', status: 'active' });
  assert.equal(ops[0].expectStatus, 'active');
  assert.deepEqual(ops[1].params.items, [{
    type: 'message', role: 'user', content: [{ type: 'input_text', text: 'pf-test failed: exit 1' }],
  }]);
  assert.equal(ops[2].params.threadId, 't-1');
  assert.equal(ops[2].params.input[0].type, 'text');
  const raised = resumeRpcOps({ threadId: 't-1', diagnosticText: 'x', tokenBudget: 58291 });
  assert.equal(raised[0].params.tokenBudget, 58291);
});

// M5：这条用例的旧名是「needs threadId + updatedAt + monotonic sequence」,但 broken 列表里那条
// {sequence:4} 同时触发 last.sequence 与 monotonic 两条判定,前者先命中——monotonic 从未被单独
// 验证过。名字改成它真正断言的东西,monotonic 的单独验证移交下面那条隔离用例。
test('finalize attribution rejects a mismatched threadId, updatedAt, status, sequence or envelope shape', () => {
  const goal = { ...completeGoal, status: 'complete', threadId: 't-1', updatedAt: 1786000451 };
  const setEnvelope = { result: { goal } };
  const readbackEnvelope = { result: { goal: { ...goal } } };
  const ledger = [
    { sequence: 1, requestedStatus: 'active', updatedAt: 1786000400, threadId: 't-1' },
    { sequence: 2, requestedStatus: 'complete', updatedAt: 1786000451, threadId: 't-1' },
  ];
  assert.deepEqual(verifyFinalizeAttribution({
    setEnvelope, readbackEnvelope, threadId: 't-1', sequence: 2, ledger,
  }), { ok: true, reasons: [] });
  const broken = [
    { readbackEnvelope: { result: { goal: { ...goal, threadId: 't-2' } } } },
    { readbackEnvelope: { result: { goal: { ...goal, updatedAt: 1786000452 } } } },
    { readbackEnvelope: { result: { goal: { ...goal, status: 'active' } } } },
    { sequence: 3 },
    { ledger: [ledger[0], { ...ledger[1], sequence: 4 }] },
    { setEnvelope: { result: {} } },
  ];
  for (const override of broken) {
    const verdict = verifyFinalizeAttribution({
      setEnvelope, readbackEnvelope, threadId: 't-1', sequence: 2, ledger, ...override,
    });
    assert.equal(verdict.ok, false);
  }
});

// M4：八条子判定里这四条零覆盖——终审逐条变异实测，删掉后 204 仍全绿。每条一个**只触发自己**
// 的用例（断言 reasons 全等，多咬一条就红），否则又会退回「一个用例同时踩两条、后一条从未被验证」
// 的老问题。setGoal.status 那条尤其要命：它是防「daemon 粘滞分支悄悄拒了 finalize 的 set，而
// readback 因模型早先自标 complete 恰好为 complete」的唯一判定，正是 §3 D5 存在的理由。
test('each finalize attribution sub-judgment fires on its own', () => {
  const goal = { ...completeGoal, status: 'complete', threadId: 't-1', updatedAt: 1786000451 };
  const base = {
    setEnvelope: { result: { goal } },
    readbackEnvelope: { result: { goal: { ...goal } } },
    threadId: 't-1',
    sequence: 2,
    ledger: [
      { sequence: 1, requestedStatus: 'active', updatedAt: 1786000400, threadId: 't-1' },
      { sequence: 2, requestedStatus: 'complete', updatedAt: 1786000451, threadId: 't-1' },
    ],
  };
  assert.deepEqual(verifyFinalizeAttribution(base), { ok: true, reasons: [] });

  const cases = [
    // 序号有洞：末条仍等于 sequence，只有 monotonic 咬得住（旧用例的 {sequence:4} 会先撞
    // last.sequence，monotonic 因此从未单独验证过）。
    [{ ledger: base.ledger.map((entry) => ({ ...entry, sequence: 2 })) },
      'goal-set ledger sequence is not strictly monotonic'],
    // 末条记的不是 complete：控制器最后一次 set 请的不是收口，这份 receipt 不该被当 finalize。
    [{ ledger: [base.ledger[0], { ...base.ledger[1], requestedStatus: 'active' }] },
      'last ledger entry did not request complete'],
    // 末条记在别的 thread 上：账本与本次 finalize 不是同一条线。
    [{ ledger: [base.ledger[0], { ...base.ledger[1], threadId: 't-2' }] },
      'ledger threadId mismatch'],
    // set 响应自身没返回 complete（粘滞分支静默拒写），readback 却是 complete——橡皮章。
    [{ setEnvelope: { result: { goal: { ...goal, status: 'active' } } } },
      'set envelope status is not complete'],
  ];
  for (const [override, reason] of cases) {
    assert.deepEqual(verifyFinalizeAttribution({ ...base, ...override }).reasons, [reason]);
  }
});

// 桩子进程必须复刻真 ChildProcess 的**异步**事件语义：spawn 成功发 'spawn'、失败发 'error'，
// 两者都在 spawn() 返回之后才到（N-1 的全部要害就在这个「之后」上）。此前的桩是个不会发事件的
// 裸对象 `{stdin, stdout, kill}`，start() 里根本没有事件可等，也就守不住这条路径。
function stubSpawn({ spawnError, autoRespond = true } = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const written = [];
  stdin.on('data', (chunk) => {
    for (const line of chunk.toString().trim().split('\n')) {
      const msg = JSON.parse(line);
      written.push(msg);
      // autoRespond:false 造「rpc 真的在飞」的形态——M-1 的要害就在这种在飞状态上。
      if (!autoRespond) continue;
      stdout.write(`${JSON.stringify({ id: msg.id, result: { thread: { id: 't-stub' }, goal: null } })}\n`);
    }
  });
  const child = new EventEmitter();
  Object.assign(child, { stdin, stdout, kill: () => {} });
  // 事件在 spawnImpl 被调用之后才排队——在 stubSpawn() 里排就会早于 start() 挂监听器，
  // 竞速永远等不到，用例会挂死而不是失败。
  const spawnImpl = () => {
    setImmediate(() => {
      if (spawnError) child.emit('error', spawnError);
      else child.emit('spawn');
    });
    return child;
  };
  return { child, written, spawnImpl };
}

test('GoalRpcClient refuses to start without an explicit codexHome', async () => {
  const client = new GoalRpcClient({ cwd: '/x', spawnImpl: () => { throw new Error('must not spawn'); } });
  await assert.rejects(() => client.start(), /CODEX_HOME/);
});

// N-1 的就地修复（最内层）：spawn 的 ENOENT 是**异步**从 'error' 事件抛出的，没有监听器时它是
// 未捕获异常——start() 早已正常返回、调用方 try/finally 早已出作用域，cleanup 一次都不跑。
// 这里只钉最内层的契约：start() 必须把它变成自己的 rejection，调用方才有 catch 得住的东西。
test('GoalRpcClient.start rejects on the async spawn error instead of leaking an uncaught exception', async () => {
  const enoent = Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT', syscall: 'spawn codex' });
  const { spawnImpl } = stubSpawn({ spawnError: enoent });
  const client = new GoalRpcClient({ codexHome: '/iso/home', cwd: '/x', spawnImpl });
  await assert.rejects(() => client.start(), (error) => {
    assert.equal(error, enoent, 'the original spawn error must survive, not be re-wrapped into a new message');
    return true;
  });
});

// 反面：竞速的另一边。'spawn' 到达前 start() 不得 resolve——否则「等 error」这件事就只是
// 摆设，ENOENT 仍然会在 start() 返回之后才到。
test('GoalRpcClient.start waits for the child process to actually spawn', async () => {
  const { child, spawnImpl } = stubSpawn();
  const client = new GoalRpcClient({ codexHome: '/iso/home', cwd: '/x', spawnImpl });
  let settled = false;
  const started = client.start().then(() => { settled = true; });
  assert.equal(settled, false, 'start() must not resolve in the same tick it spawned');
  await started;
  assert.equal(settled, true);
  assert.equal(child.listenerCount('error'), 1, 'the error listener must stay registered after start()');
});

test('threadStart forces ephemeral:false and exact method names are used', async () => {
  const { written, spawnImpl } = stubSpawn();
  const client = new GoalRpcClient({ codexHome: '/iso/home', cwd: '/x', spawnImpl });
  await client.start();
  await client.initialize();
  await client.threadStart({ ephemeral: true });        // 调用方尝试覆盖也必须被钉回 false
  await client.goalSet({ threadId: 't-stub', objective: 'o' });
  await client.goalGet({ threadId: 't-stub' });
  // inject 没有具名方法（M8：唯一调用方 runCodexResume 走通用 rpc，params 只认 resumeRpcOps）。
  await client.rpc('thread/inject_items', resumeRpcOps({ threadId: 't-stub', diagnosticText: 'd' })[1].params);
  await client.turnStart({ threadId: 't-stub', text: 'go' });
  const methods = written.map((msg) => msg.method);
  assert.deepEqual(methods, ['initialize', 'thread/start', 'thread/goal/set', 'thread/goal/get',
    'thread/inject_items', 'turn/start']);
  assert.equal(client.injectItems, undefined, 'no named injectItems wrapper may reappear');
  assert.equal(written[1].params.ephemeral, false);
  assert.equal(written[0].params.clientInfo.name, 'goal-condition-launch');
});

test('every request and response envelope reaches onEnvelope', async () => {
  const { spawnImpl } = stubSpawn();
  const envelopes = [];
  const client = new GoalRpcClient({
    codexHome: '/iso/home', cwd: '/x', spawnImpl, onEnvelope: (entry) => envelopes.push(entry),
  });
  await client.start();
  await client.initialize();
  assert.deepEqual(envelopes.map((entry) => entry.direction), ['request', 'response']);
});

const goodCodexProbes = Object.freeze({
  contractHash: 'a'.repeat(64),
  confirmedHash: 'a'.repeat(64),
  baselineDigestStored: true,
  codexVersionRaw: 'codex-cli 0.146.0-alpha.9.2\n',
  sandboxMode: 'workspace-write',
  // state 目录必须在执行体可写面之外：不在任一 target root 内，也不在临时目录内。
  // 三项都由采集层归一后传入（路径比较不能拿 symlink 的两边硬比）。
  stateDir: '/controller/state/default/aaaa',
  targetRoots: ['/work/root'],
  temporaryRoot: '/var/folders/xx/T',
  leaseResidue: 'none',
});

const sandboxContract = Object.freeze({
  constraints: [
    {
      id: 'c-sandbox',
      enforcement: 'physical',
      rule: 'writes are confined to target_roots',
      mechanism: 'OS sandbox (macOS Seatbelt) enforces --sandbox workspace-write',
      verify: 'inspect the sandbox-exec profile applied to the codex subprocess',
    },
  ],
});

test('assertLaunchable pins CODEX_SANDBOX_MODE to workspace-write', () => {
  assert.equal(CODEX_SANDBOX_MODE, 'workspace-write');
});

test('assertLaunchable passes the good probe set and fails each broken one', () => {
  assert.deepEqual(assertLaunchable(sandboxContract, goodCodexProbes), { ok: true, reasons: [] });
  const broken = [
    { ...goodCodexProbes, confirmedHash: 'b'.repeat(64) },
    { ...goodCodexProbes, baselineDigestStored: false },
    { ...goodCodexProbes, codexVersionRaw: '' },
    { ...goodCodexProbes, codexVersionRaw: undefined },
    { ...goodCodexProbes, sandboxMode: 'read-only' },
    { ...goodCodexProbes, leaseResidue: 'live' },
    { ...goodCodexProbes, leaseResidue: 'stale' },
    { ...goodCodexProbes, leaseResidue: undefined },
    { ...goodCodexProbes, leaseResidue: 'whatever' },     // 未知词形 fail-closed
  ];
  for (const probes of broken) {
    const verdict = assertLaunchable(sandboxContract, probes);
    assert.equal(verdict.ok, false);
    assert.ok(verdict.reasons.length > 0);
  }
});

// state 目录里住着**全部** controller-owned 证据（receipt、readback、ledger、thread 坐标、按 attempt
// 归档的候选）。执行体写得到它，codex 线的整个证据模型都不成立——而这条前提此前既没写下来也没核过，
// 新加的陈旧候选闸正是建在它之上的。两条判据各拦一种放错位置的形态。
test('a state directory the executor can write is refused before launch, whichever way it is reachable', () => {
  const refused = (probes, expected) => {
    const verdict = assertLaunchable(sandboxContract, probes);
    assert.equal(verdict.ok, false, JSON.stringify(probes.stateDir));
    assert.ok(verdict.reasons.some((reason) => expected.test(reason)),
      `${JSON.stringify(probes.stateDir)} -> ${JSON.stringify(verdict.reasons)}`);
    // 出路必须写在 reason 里：操作员要知道换 --state-root，而不是猜。
    assert.ok(verdict.reasons.some((reason) => reason.includes('--state-root')));
  };

  // ① target root 之内——那正是 --sandbox workspace-write 授权可写的地方。目录自身与其子目录都算。
  refused({ ...goodCodexProbes, stateDir: '/work/root' }, /inside a contract target root/);
  refused({ ...goodCodexProbes, stateDir: '/work/root/.goal-state/x' }, /inside a contract target root/);
  // 前缀相同但不是子目录的兄弟目录不算（否则 /work/root-backup 会被误伤）。
  assert.deepEqual(assertLaunchable(sandboxContract, { ...goodCodexProbes, stateDir: '/work/root-backup' }),
    { ok: true, reasons: [] });

  // ② 临时目录之内——沙箱把 /tmp 与 $TMPDIR 都留在可写面内。标准位置由 isTemporaryPath 认……
  for (const stateDir of ['/tmp/state', '/private/tmp/state', '/var/folders/ab/T/state']) {
    refused({ ...goodCodexProbes, stateDir }, /sits in a temporary directory/);
  }
  // ……被改过的 TMPDIR 只有实际生效值认得出：正则看不出 /scratch/mytmp 是临时目录。
  refused({ ...goodCodexProbes, stateDir: '/scratch/mytmp/state', temporaryRoot: '/scratch/mytmp' },
    /sits in a temporary directory/);

  // ③ 采集不到就核不了，核不了不等于核过了。
  for (const stateDir of [undefined, '', 42]) {
    refused({ ...goodCodexProbes, stateDir }, /was not collected/);
  }

  // target roots 同样是位置判定必需的采集值：空集合不是「没有命中」，而是根本无法做比较。
  // 元素类型一并判（口径同 assertResumedSession）——只判非空时，`[42]` 这类采集残骸会被闸内那个
  // 逐元素 typeof filter 整个滤掉，「比不了」于是又变回「没命中」，同一个 fail-open 只是下沉一层。
  for (const targetRoots of [undefined, [], [42], [null], [undefined], ['/work/root', 42]]) {
    refused({ ...goodCodexProbes, targetRoots }, /target roots were not collected/);
  }
});

// F-2 附带：版本闸此前只判 `codexVersionRaw` 是非空字符串，而 prepare 探测失败时落盘的正是
// `probe failed: …`（非空）——「codex 根本没装 / PATH 不通」因此一路绿灯进到 auth-copy。
test('the codex version gate needs a parsed version, so a failed probe cannot pass as "collected"', () => {
  for (const raw of [
    'probe failed: Command failed: codex --version\n/bin/sh: codex: command not found\n',
    // 失败文本里夹带版本号形态也不行：`probe failed:` 前缀独立判死，不给 match 蒙混的机会。
    'probe failed: spawn /opt/homebrew/Cellar/node/24.3.0/bin/codex ENOENT',
    '   probe failed: whatever 1.2.3',
    'codex-cli\n',            // 有输出但没有版本号形态
    'unknown',
    '',
    undefined,
    null,
    42,
  ]) {
    const verdict = assertLaunchable(sandboxContract, { ...goodCodexProbes, codexVersionRaw: raw });
    assert.equal(verdict.ok, false, JSON.stringify(raw));
    assert.ok(
      verdict.reasons.some((reason) => reason.includes('install codex or fix PATH')),
      `${JSON.stringify(raw)} → ${JSON.stringify(verdict.reasons)}`,
    );
  }

  // 反面：真实 `codex --version` 形态照常绿（alpha 后缀不影响解析）。
  for (const raw of ['codex-cli 0.146.0-alpha.9.2\n', 'codex-cli 0.147.0-alpha.1.2\n', 'codex 1.0.0']) {
    assert.deepEqual(
      assertLaunchable(sandboxContract, { ...goodCodexProbes, codexVersionRaw: raw }),
      { ok: true, reasons: [] },
      JSON.stringify(raw),
    );
  }
});

test('parseCodexVersion returns the version string itself so the reason can stay specific', () => {
  assert.equal(parseCodexVersion('codex-cli 0.147.0-alpha.1.2\n'), '0.147.0');
  assert.equal(parseCodexVersion('probe failed: codex 1.2.3'), null);
  assert.equal(parseCodexVersion(''), null);
  assert.equal(parseCodexVersion(undefined), null);
});

// 终审 I2：过期租约此前直接放行 relaunch（判据是「超 TTL 就认定进程真死了」）。但持有者死掉
// 不代表它起的 app-server 也死了——租约到期不触发任何 clear，孤儿 daemon 是否随 stdio EOF 自退
// 本轮未实测。放行等于在同一 target root 上叠第二个执行器，出口因此改成先跑 close。
// N-2：这条诊断此前只说「run close」，而 close 读不到 codex-home.path 就直接 return——两句话
// 互相指认，磁盘一动不动。出路必须写成可执行的 next=，且与 close 现在真做得到的事对得上。
test('a stale lease is a distinct red pointing at close, not a green light to relaunch', () => {
  const stale = assertLaunchable(sandboxContract, { ...goodCodexProbes, leaseResidue: 'stale' });
  assert.equal(stale.ok, false);
  assert.equal(stale.reasons.length, 1);
  assert.match(stale.reasons[0], /^a residual lease\.json remains in the state directory: next=run `close`/);
  // 光说 close 不够：N-2 的死循环正是「close 说没什么可关」。出路必须点明 close 在没有
  // codex-home.path 时也会释放租约，否则操作员照旧卡在那两句话之间。
  assert.match(stale.reasons[0], /no codex-home\.path/);
  assert.match(stale.reasons[0], /--controller/);

  // 活租约仍是它自己那条 reason（两种残留不混为一谈：一个是并发，一个是清理欠账）。
  const live = assertLaunchable(sandboxContract, { ...goodCodexProbes, leaseResidue: 'live' });
  assert.deepEqual(live.reasons, ['a live lease.json already exists in the state directory']);
});

// N2（re-review round 1 补审）：`if (!mechanism.includes('sandbox')) continue` 让「不提 sandbox 的
// physical 约束」（proxy、只读凭证）乃至「根本没有 mechanism 字段」的整个溜过去——实测各自
// ok:true、零核验。spec §5 要求的是**逐条**对应：每一条 physical 约束都要对上真实机制，不是
// 「每一条提到 sandbox 的」。本 adapter 唯一的物理面就是 --sandbox，其余机制 controller 侧无从
// 验证，一律红。旧用例把 c-unrelated（physical + 不提 sandbox）断言成 ok:true，正是这个洞的
// 成文化，一并纠正。四种形态各一条，断言 reasons 全等——多咬一条或咬错一条都红。
test('every physical constraint is checked one by one against the only physical surface: --sandbox', () => {
  const base = { id: 'c-x', rule: 'x', verify: 'x' };
  const withConstraint = (constraint) => assertLaunchable({ constraints: [constraint] }, goodCodexProbes);
  const unsupported = "constraint c-x claims physical enforcement, but this adapter's only physical surface "
    + 'is --sandbox: mechanisms such as an egress proxy or read-only credentials cannot be verified '
    + 'controller-side, so rewrite the constraint as audit_only';

  // ① sandbox 机制对得上实际模式：这是本 runtime 上唯一能过的 physical 形态。
  assert.deepEqual(withConstraint({
    ...base, enforcement: 'physical', mechanism: 'OS sandbox (macOS Seatbelt) enforces --sandbox workspace-write',
  }), { ok: true, reasons: [] });

  // ② sandbox 机制对不上实际模式：红在「模式不符」，不是「机制不支持」——两条诊断指向不同修法。
  assert.deepEqual(withConstraint({
    ...base, enforcement: 'physical', mechanism: 'OS sandbox enforces --sandbox read-only',
  }).reasons, ['constraint c-x declares a sandbox mechanism that does not match the actual sandbox mode']);

  // ③ 不指向 sandbox 的物理机制：controller 侧无从验证，红。
  for (const mechanism of ['network egress proxy denies all hosts', 'read-only credentials']) {
    assert.deepEqual(withConstraint({ ...base, enforcement: 'physical', mechanism }).reasons, [unsupported]);
  }

  // ④ 连 mechanism 字段都没有：此前 typeof 检查后直接 continue 放过，现在同样红。
  assert.deepEqual(withConstraint({ ...base, enforcement: 'physical' }).reasons, [unsupported]);

  // audit_only 不进这条闸（是否物理拦得住本来就不是它的承诺）。
  assert.deepEqual(withConstraint({
    ...base, enforcement: 'audit_only', mechanism: 'network egress proxy denies all hosts',
  }), { ok: true, reasons: [] });
});

// ---------------------------------------------------------------------------
// N-5：通知的落盘收敛规则。`account/rateLimits/updated` 在 NOTIFICATION_METHODS 里列着却一个字
// 都没落盘，于是终局报告只说得出 "goal reached usageLimited"，说不出「credits 余额 0、8/12 重置」；
// 而 close 会把唯一存着该信息的 codexHome 连 rollout 日志一起删掉。
// ---------------------------------------------------------------------------

test('noteworthyNotification records the rate-limit signal that explains a usageLimited terminal', () => {
  // 形状取自真实 rollout 日志里的 token_count.rate_limits（冒烟报告逐字摘录）。
  const note = noteworthyNotification({
    method: 'account/rateLimits/updated',
    params: { rate_limits: { limit_id: 'premium', credits: { has_credits: false, unlimited: false, balance: '0' } } },
  });
  assert.equal(note.record, true);
  assert.equal(note.method, 'account/rateLimits/updated');
  // 落的是成因本身，不是「有过这么一条通知」。
  assert.match(note.payload, /"balance":"0"/);
  assert.match(note.payload, /"has_credits":false/);
});

// 形状随 alpha 漂移是常态，钉死单一字段路径会在下一个版本上静默漏掉整条信号。
test('noteworthyNotification tolerates the camelCase and bare-params shapes of the rate-limit notification', () => {
  assert.match(noteworthyNotification({
    method: 'account/rateLimits/updated', params: { rateLimits: { credits: { balance: '7' } } },
  }).payload, /"balance":"7"/);
  assert.match(noteworthyNotification({
    method: 'account/rateLimits/updated', params: { credits: { balance: '9' } },
  }).payload, /"balance":"9"/);
});

test('noteworthyNotification records turn/completed only when it carries an error body', () => {
  const failed = noteworthyNotification({
    method: 'turn/completed',
    params: { error: { message: "You've hit your usage limit.", codex_error_info: 'usage_limit_exceeded' } },
  });
  assert.equal(failed.record, true);
  assert.match(failed.payload, /usage_limit_exceeded/);
  assert.equal(noteworthyNotification({
    method: 'turn/completed', params: { turn: { error: { codex_error_info: 'nested' } } },
  }).record, true);

  // 无 error 的 turn 已经由 turn-counts.json 计过数，再落一条只是噪声。
  for (const params of [{ turn: { id: 't-1' } }, { error: null }, {}, undefined]) {
    assert.equal(noteworthyNotification({ method: 'turn/completed', params }).record, false, JSON.stringify(params));
  }
});

// 排除项是这条规则的一半：把它们放进来会把 envelope 日志撑爆，并把执行体产出的**内容**
// （模型输出、工作树 diff）写进证据通道。
test('noteworthyNotification records nothing for high-frequency or content-bearing notifications', () => {
  for (const method of ['item/agentMessage/delta', 'turn/diff/updated', 'item/started', 'item/completed',
    'thread/tokenUsage/updated', 'thread/started', 'turn/started', 'unknown/method']) {
    assert.deepEqual(noteworthyNotification({ method, params: { text: 'x'.repeat(100) } }), { record: false }, method);
  }
  assert.deepEqual(noteworthyNotification(), { record: false });
});

test('noteworthyNotification caps the payload so an oversized notification cannot flood the evidence log', () => {
  const note = noteworthyNotification({
    method: 'account/rateLimits/updated', params: { rate_limits: { blob: 'x'.repeat(NOTIFICATION_PAYLOAD_CAP * 3) } },
  });
  assert.equal(note.record, true);
  assert.ok(note.payload.length < NOTIFICATION_PAYLOAD_CAP * 2, `payload was ${note.payload.length} chars`);
  assert.match(note.payload, /truncated \d+ chars/);
});

// ---------------------------------------------------------------------------
// M-1：同一条铁律的第四种失效形态——事件循环耗尽。
// 根因链是代码里现成的两条静态声明：rpc 的超时 timer 显式 .unref()（因为 _wire 收到响应时从不
// clearTimeout，不 unref 就会有悬空 timer 把进程多挂 60s），于是**真正在飞**的那次 rpc 也一并
// 不再撑住事件循环。app-server 中途死掉、且此刻恰好没有别的 handle 时，事件循环直接排空，Node
// 静默退出：没有异常、没有信号，四路进程级兜底一个都不响，finally 也永远等不到那个 await 恢复。
// ---------------------------------------------------------------------------

const activeTimeouts = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

test('an in-flight rpc holds the event loop open, and a completed one leaves no timer behind', async () => {
  const { spawnImpl } = stubSpawn({ autoRespond: false });
  const client = new GoalRpcClient({ codexHome: '/iso/home', cwd: '/x', spawnImpl });
  await client.start();
  const baseline = activeTimeouts();

  // ① 在飞的 rpc 必须 ref 住事件循环。这是 M-1 的根因判据：unref 掉的 timer 不出现在 active
  //    资源里，也就撑不住事件循环——app-server 一死，循环立刻排空。
  const inFlight = client.rpc('thread/goal/get', { threadId: 't-stub' });
  assert.equal(activeTimeouts(), baseline + 1, 'a pending rpc must keep the event loop alive');

  // ② 但已经答复的 rpc 不许留下悬空 timer——那正是当初加 .unref() 要解决的问题。只把 .unref()
  //    去掉而不 clearTimeout，会让每次 rpc 都把进程多挂 60s。
  const { spawnImpl: answering } = stubSpawn();
  const answered = new GoalRpcClient({ codexHome: '/iso/home', cwd: '/x', spawnImpl: answering });
  await answered.start();
  const beforeAnswered = activeTimeouts();
  await answered.rpc('thread/goal/get', { threadId: 't-stub' });
  assert.equal(activeTimeouts(), beforeAnswered, 'a settled rpc must not leave a timer holding the loop');

  await client.stop();
  await assert.rejects(() => inFlight);
});

test('a child process that exits mid-run rejects the in-flight rpc with an honest reason', async () => {
  const { child, spawnImpl } = stubSpawn({ autoRespond: false });
  const failures = [];
  const client = new GoalRpcClient({
    codexHome: '/iso/home', cwd: '/x', spawnImpl, onChildFailure: (error) => failures.push(error),
  });
  await client.start();

  const inFlight = client.rpc('thread/goal/get', { threadId: 't-stub' });
  child.emit('exit', 0, null);

  await assert.rejects(() => inFlight, (error) => {
    // 措辞必须说「app-server 退出了」。超时那条只会说 `RPC timeout: thread/goal/get`——
    // 它既慢 60s，又把成因说成了别的东西（review m-3）。
    assert.match(error.message, /codex app-server exited before the run finished/);
    assert.match(error.message, /code=0/);
    return true;
  });
  assert.equal(failures.length, 1, 'the child failure must reach the trace channel exactly once');
});

test('after the child is gone every further rpc fails fast instead of waiting out the 60s timeout', async () => {
  const { child, spawnImpl } = stubSpawn({ autoRespond: false });
  const client = new GoalRpcClient({ codexHome: '/iso/home', cwd: '/x', spawnImpl });
  await client.start();
  child.emit('exit', 1, null);

  const startedAt = Date.now();
  await assert.rejects(() => client.rpc('thread/goal/get', { threadId: 't-stub' }),
    /codex app-server exited before the run finished/);
  assert.ok(Date.now() - startedAt < 1000, 'must not wait for the rpc timeout');
  // 两拍轮询之间子进程死掉正是这条路径：此刻没有在飞的 rpc，下一次 rpc 必须自己说得出成因。
  assert.equal(activeTimeouts(), process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length);
});

// review m-3：start() 之后到达的 'error' 此前被 `failed.catch(() => {})` 完全吞掉——两拍轮询之间
// 到达时这条错误彻底消失，连一行日志都没有。reviewer 指出用本文件自己的 stubSpawn 姿态就能构造，
// 「单测里造不出可信场景」的说法不成立。
test('an error arriving after a successful spawn is traced instead of being swallowed', async () => {
  const { child, spawnImpl } = stubSpawn({ autoRespond: false });
  const failures = [];
  const client = new GoalRpcClient({
    codexHome: '/iso/home', cwd: '/x', spawnImpl, onChildFailure: (error) => failures.push(error),
  });
  await client.start();          // 先正常起来（'spawn' 已经发过）

  const boom = Object.assign(new Error('EPIPE after spawn'), { code: 'EPIPE' });
  child.emit('error', boom);

  assert.deepEqual(failures, [boom], 'the post-start error must reach the trace channel');
  // 且后续的 rpc 以这条真成因失败，而不是 60s 之后报一句 RPC timeout。
  await assert.rejects(() => client.rpc('thread/goal/get', {}), /EPIPE after spawn/);
});

// f-1：留痕通道抛错时 adapter 侧的两条保证，各自对应同一条路上的一段。
// ① settle 排在留痕之前——本职（让在飞的 rpc 如实失败）不依赖 catch 生效。判据用 timer：
//    _settle 会 clearTimeout，所以「留痕那一刻还剩几个 Timeout」就说得出 settle 跑没跑过。
// ② 留痕抛出的东西不得逃出监听器——生产里这两个调用点（proc.on('error')/'exit'）栈上没有任何
//    catch，逃出去就是 uncaughtException → 进程级兜底 exit(1)，rejection 的 continuation 一次都
//    跑不到（realrun review 发现 1）。emit 不抛，就是它没逃。
// 本用例只钉 adapter 契约；「仍出终局报告」那条验收后果由 launch.test.mjs 的真件接线用例跑。
// 此前这里写的是 `assert.throws(() => child.emit(...))`——那等于用例自己接住了生产里没人接的
// 那次逃逸，验的只是「reject() 被调用过」，还得靠 60s rpc 超时才分辨得出变异（发现 2）。
test('a throwing child-failure trace callback neither escapes nor strands an in-flight rpc', async () => {
  const { child, spawnImpl } = stubSpawn({ autoRespond: false });
  const traceFailure = new Error('trace sink failed');
  const childFailure = new Error('app-server pipe broke');
  const traced = [];
  let timersWhenTraced = null;
  const client = new GoalRpcClient({
    codexHome: '/iso/home',
    cwd: '/x',
    spawnImpl,
    onChildFailure: (error) => {
      traced.push(error);
      timersWhenTraced = activeTimeouts();
      throw traceFailure;
    },
  });
  await client.start();

  const baseline = activeTimeouts();
  const inFlight = client.rpc('thread/goal/get', { threadId: 't-stub' });
  assert.equal(activeTimeouts(), baseline + 1, 'the in-flight rpc must own a timer for the ordering check to mean anything');

  const startedAt = Date.now();
  assert.doesNotThrow(() => child.emit('error', childFailure),
    'a throwing trace callback must not escape the child-failure listener');
  await assert.rejects(() => inFlight, (error) => {
    assert.equal(error, childFailure, 'the in-flight rpc must fail with the real cause, not the trace failure');
    return true;
  });
  assert.ok(Date.now() - startedAt < 1000, 'the rejection must be immediate, not the 60s rpc timeout');
  assert.deepEqual(traced, [childFailure], 'the real cause must still reach the trace channel exactly once');
  assert.equal(timersWhenTraced, baseline,
    'every pending rpc must already be settled by the time the trace callback runs');
});

// 这条关系是 M-3 存在的理由，钉成文：心跳只在轮询每拍与连接阶段各刷一次，两次刷新之间最长
// 可达 pollInterval + RPC_TIMEOUT_MS，**远超**租约 TTL。所以「心跳过期」不足以断言持有者死了。
// 若有人日后把 TTL 抬到超过 rpc 超时并据此拿掉 pid 探活，这条会红。
test('the lease TTL is shorter than a single rpc timeout, so heartbeat alone cannot prove death', () => {
  assert.ok(LEASE_TTL_MS < RPC_TIMEOUT_MS,
    `LEASE_TTL_MS=${LEASE_TTL_MS} must stay below RPC_TIMEOUT_MS=${RPC_TIMEOUT_MS} for the M-3 reasoning to hold`);
});
