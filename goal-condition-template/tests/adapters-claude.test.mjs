import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CLAUDE_RESULT_KEYS, CLAUDE_ERROR_MAX_TURNS_KEYS, normalizeTerminal, buildStopHook, buildSettings, MAX_HOOK_BLOCKS, assertLaunchable, launchSpec, resumeSpec, DEFAULT_MAX_TURNS, MAX_TURNS_CEILING } from '../scripts/lib/adapters/claude.mjs';
import { runtimeTerminalState } from '../scripts/lib/workflow.mjs';

const fixtureUrl = new URL('./fixtures/claude-result-21key.json', import.meta.url);
const realResult = JSON.parse(await readFile(fixtureUrl, 'utf8'));

// spike S-B（2.1.228）的实测产物：--max-turns 1 触发硬停，CLI 出 error 形态 envelope。与
// 2026-08-10/08-12 两次真实 run 在 2.1.226/2.1.228 的观测逐 key 一致。形状从实测文件读，不手抄。
const errorFixtureUrl = new URL('./fixtures/claude-result-17key-error-max-turns.json', import.meta.url);
const errorMaxTurnsResult = JSON.parse(await readFile(errorFixtureUrl, 'utf8'));

// spike S5 runB 的实测产物：模型改不动 hook 就换 Bash 直接重定向（`printf 'exit 0' > stop-hook.sh`），
// 被 settings.permissions.deny 挡下，留下这条 permission_denials 记录。形状从实测文件读，不手抄。
const denySurfaceUrl = new URL('../../spikes/goal-runtime-adapters-v2/fixtures/s5-deny-surface.json', import.meta.url);
const denySurface = JSON.parse(await readFile(denySurfaceUrl, 'utf8'));
const bashRedirectDenial = denySurface.runB.permissionDenials[0];

test('CLAUDE_RESULT_KEYS pins the measured 2.1.223 result envelope exactly', () => {
  assert.equal(CLAUDE_RESULT_KEYS.length, 21);
  assert.deepEqual([...Object.keys(realResult)].sort(), [...CLAUDE_RESULT_KEYS].sort());
});

test('normalizeTerminal projects exactly four fields from a full real envelope', () => {
  const normalized = normalizeTerminal(realResult);
  assert.equal(normalized.ok, true);
  assert.deepEqual(normalized.candidate, {
    subtype: 'success', is_error: false, terminal_reason: 'completed', permission_denials: [],
  });
  assert.deepEqual(runtimeTerminalState('claude', normalized.candidate), { ok: true, reasons: [] });
});

test('normalizeTerminal fails closed on unknown, missing, or non-object input', () => {
  for (const raw of [
    null, [], 'text',
    { ...realResult, surprise_key: 1 },                       // 未知 key
    (() => { const c = { ...realResult }; delete c.uuid; return c; })(),   // 缺 key
  ]) {
    const normalized = normalizeTerminal(raw);
    assert.equal(normalized.ok, false);
    assert.ok(normalized.reasons.length > 0);
    assert.ok(!('candidate' in normalized));
  }
});

// ---------------------------------------------------------------------------
// error_max_turns 第二锚（D5）：「没干完」和「协议漂移」是两类事。2026-08-10 真实 run 里
// max-turns 硬停的 17-key envelope 被单锚判成 malformed，thread.json 不落盘，resume 死锁。
// ---------------------------------------------------------------------------

test('CLAUDE_ERROR_MAX_TURNS_KEYS pins the measured error envelope exactly', () => {
  assert.equal(CLAUDE_ERROR_MAX_TURNS_KEYS.length, 17);
  assert.deepEqual([...Object.keys(errorMaxTurnsResult)].sort(), [...CLAUDE_ERROR_MAX_TURNS_KEYS].sort());
  // 与成功锚的差集也是实测事实（少 5 多 1），锚表改动必须两边一起过目。
  const success = new Set(CLAUDE_RESULT_KEYS);
  const error = new Set(CLAUDE_ERROR_MAX_TURNS_KEYS);
  assert.deepEqual(
    CLAUDE_RESULT_KEYS.filter((key) => !error.has(key)).sort(),
    ['api_error_status', 'result', 'time_to_request_ms', 'ttft_ms', 'ttft_stream_ms'],
  );
  assert.deepEqual(CLAUDE_ERROR_MAX_TURNS_KEYS.filter((key) => !success.has(key)), ['errors']);
});

test('a measured error_max_turns envelope is a budget-exhausted candidate, not a terminal report', () => {
  const normalized = normalizeTerminal(errorMaxTurnsResult);
  assert.equal(normalized.ok, true);
  assert.equal(normalized.budgetExhausted, true);
  // candidate 恒 4 字段：budgetExhausted 是报告体信号，不得混进 candidate——workflow.mjs 的
  // claudeTerminalState 做闭世界形状检查，多一个字段就把「未达标」变成形状错误。
  assert.deepEqual(Object.keys(normalized.candidate).sort(),
    ['is_error', 'permission_denials', 'subtype', 'terminal_reason']);
  assert.equal(normalized.candidate.subtype, 'error_max_turns');
  assert.equal(normalized.candidate.terminal_reason, 'max_turns');
  // 它是候选但不是达标候选：公共状态机照常拒绝 Close，这正是「如实标注未达标」。
  const verdict = runtimeTerminalState('claude', normalized.candidate);
  assert.equal(verdict.ok, false);
});

test('error_max_turns routing requires the complete measured discriminator tuple', () => {
  for (const [field, value] of [
    ['type', 'assistant'],
    ['is_error', false],
    ['terminal_reason', 'completed'],
  ]) {
    const normalized = normalizeTerminal({ ...errorMaxTurnsResult, [field]: value });
    assert.equal(normalized.ok, false, `${field} must be value-anchored`);
    assert.ok(normalized.reasons.some((reason) => reason.includes('discriminator')));
    assert.equal(normalized.budgetExhausted, undefined);
  }
});

test('the success path reports budgetExhausted=false explicitly', () => {
  assert.equal(normalizeTerminal(realResult).budgetExhausted, false);
});

test('provider status is preserved outside the four-field candidate as a privacy-safe blocker signal', () => {
  const normalized = normalizeTerminal({ ...realResult, api_error_status: 429, is_error: true });
  assert.equal(normalized.ok, true);
  assert.deepEqual(normalized.providerBlocker, { api_error_status: 429 });
  assert.deepEqual(Object.keys(normalized.candidate).sort(),
    ['is_error', 'permission_denials', 'subtype', 'terminal_reason']);
  assert.equal(JSON.stringify(normalized.providerBlocker).includes(realResult.result), false);
});

test('the error anchor is exhaustive: every key removed or added fails closed', () => {
  for (const key of CLAUDE_ERROR_MAX_TURNS_KEYS) {
    const mutated = { ...errorMaxTurnsResult };
    delete mutated[key];
    // 删 subtype 本身会把判定送回成功锚——两种走向都必须红。
    const normalized = normalizeTerminal(mutated);
    assert.equal(normalized.ok, false, `deleting ${key} must fail closed`);
  }
  const extra = normalizeTerminal({ ...errorMaxTurnsResult, surprise_key: 1 });
  assert.equal(extra.ok, false);
  // 隐私纪律与成功锚同款：只给计数，不回显 key 名。
  assert.ok(extra.reasons.every((reason) => !reason.includes('surprise_key')));
});

test('cross-shape confusion fails closed in both directions and hints the right table', () => {
  // 成功形态谎报 error_max_turns：按 error 锚判，多 5 缺 1，红。
  const successBody = normalizeTerminal({ ...realResult, subtype: 'error_max_turns' });
  assert.equal(successBody.ok, false);
  assert.ok(successBody.reasons.some((reason) => reason.includes('CLAUDE_ERROR_MAX_TURNS_KEYS')));
  // error 形态谎报 success：按成功锚判，缺 5 多 1，红。
  const errorBody = normalizeTerminal({ ...errorMaxTurnsResult, subtype: 'success' });
  assert.equal(errorBody.ok, false);
  assert.ok(errorBody.reasons.some((reason) => reason.includes('CLAUDE_RESULT_KEYS')));
  // 没建锚的 error subtype（形状同为 17-key）不放行：只为实测过的形态建锚，其余 fail closed。
  const unanchored = normalizeTerminal({ ...errorMaxTurnsResult, subtype: 'error_during_execution' });
  assert.equal(unanchored.ok, false);
});

// fault injection 类别③（hook 篡改探针）的 pipeline 末端：探针层（assertLaunchable 的 sha256/mode/
// deny 三项）挡的是**发车前**已被改过的 hook；这条挡的是**跑完之后**才暴露的篡改尝试。两层职责不同，
// 缺了这层，一次「Bash 绕过被拒但任务照常跑完」的 run 会带着 success 收尾，篡改痕迹只留在没人看的字段里。
test('a measured Bash-redirect hook tamper attempt normalizes but fails the terminal-state gate', () => {
  assert.equal(bashRedirectDenial.tool_name, 'Bash');                       // 实测形状仍是 Bash 旁路
  assert.match(bashRedirectDenial.tool_input.command, />\s*\S*stop-hook\.sh/);  // 直接重定向改 hook

  const tampered = { ...realResult, permission_denials: [bashRedirectDenial] };
  const normalized = normalizeTerminal(tampered);
  // 21-key 全集没变，形状层照常放行——normalizeTerminal 不是内容判官，这里的 ok:true 是设计而非漏网。
  assert.equal(normalized.ok, true);
  assert.deepEqual(normalized.candidate.permission_denials, [bashRedirectDenial]);

  const verdict = runtimeTerminalState('claude', normalized.candidate);
  assert.equal(verdict.ok, false);
  assert.ok(verdict.reasons.includes('Claude has permission denials'));
});

// 版本闸从精确 allowlist 改成下限之后，「新版本改了 result envelope」这件事全靠这道直检兜底——
// 它必须照常红，而且诊断要能直接指路：只说「多了 1 个未知 key」的操作员不知道下一步是核对新版本的
// result envelope 再改 CLAUDE_RESULT_KEYS。
test('envelope drift stays fail closed and says an upgrade may be the cause', () => {
  const drifted = [
    { ...realResult, brand_new_field: 'shipped by a newer claude' },                 // 升版多一个 key
    (() => { const c = { ...realResult }; delete c.ttft_stream_ms; return c; })(),   // 升版少一个 key
  ];
  for (const raw of drifted) {
    const normalized = normalizeTerminal(raw);
    assert.equal(normalized.ok, false);
    assert.ok(normalized.reasons.some((reason) => reason.includes('upgrade')),
      'the diagnosis must name a claude upgrade as the likely cause');
    assert.ok(normalized.reasons.some((reason) => reason.includes('CLAUDE_RESULT_KEYS')),
      'the diagnosis must name the constant the operator has to update');
    // 隐私纪律不变：只给计数，漂移的 key 名一个都不回显。
    assert.ok(normalized.reasons.every(
      (reason) => !reason.includes('brand_new_field') && !reason.includes('ttft_stream_ms'),
    ));
  }
});

test('diagnostics stay privacy-safe: counts only, never raw key names', () => {
  const normalized = normalizeTerminal({ ...realResult, SECRET_LOOKING_KEY: 'x' });
  assert.ok(normalized.reasons.every((reason) => !reason.includes('SECRET_LOOKING_KEY')));
});

const hookContract = {
  objective: 'demo',
  budget: { user_provided: true, max_minutes: 30, max_turns: 5 },
  target_roots: ['/work/root'],
  postflight: [
    { id: 'pf-test', type: 'command', cwd: '/work/root', argv: ['npm', 'test'], capture: 'hash' },
    { id: 'pf-artifact', type: 'command', cwd: '/work/root', argv: ['test', '-f', 'out.txt'], requires_env: ['CI_TOKEN_NAME'] },
  ],
};

test('buildStopHook embeds only id/cwd/argv projections and the block protocol', () => {
  const { script } = buildStopHook({ contract: hookContract, stateDir: '/state/dir' });
  assert.match(script, /"decision":\s*"block"|'decision'/);          // JSON decision 协议
  assert.doesNotMatch(script, /exit\(2\)|process\.exit\(2\)/);        // 非 exit 2
  assert.match(script, /execFileSync/);                               // argv 语义
  assert.doesNotMatch(script, /sh -c|bash -c|eval\(/);                // 无 shell 字符串
  assert.match(script, /pf-test/);
  assert.doesNotMatch(script, /"capture"/);                           // capture 不进 hook
  assert.match(script, /hook-runs\.jsonl/);
  assert.match(script, /hook-blocks\.count/);
  assert.match(script, /Continue working toward the original objective/);  // reason 与 objective 兼容
});

test('buildStopHook maps user budget into embedded limits', () => {
  const { script } = buildStopHook({ contract: hookContract, stateDir: '/state/dir' });
  assert.match(script, /maxBlocks = 5/);                 // min(8, max_turns=5)
  assert.match(script, /maxWallMs = 1800000/);           // 30 分钟
  const noBudget = buildStopHook({ contract: { ...hookContract, budget: undefined }, stateDir: '/state/dir' });
  assert.match(noBudget.script, new RegExp(`maxBlocks = ${MAX_HOOK_BLOCKS}`));
  assert.match(noBudget.script, /maxWallMs = null/);
});

test('buildSettings compiles contract permissions and protects controller state', () => {
  const contract = {
    ...hookContract,
    target_roots: ['/work/root-link', '/work/other-link'],
    execution_permissions: {
      bash_prefixes: ['git add', 'npm'],
      webfetch_domains: ['cloud.langfuse.com'],
      skills: ['langfuse'],
      additional_read_roots: ['/reference/link'],
    },
  };
  const settings = buildSettings({
    contract,
    hookScriptPath: '/state/dir/stop-hook.mjs',
    stateDir: '/state/dir',
    targetRoots: ['/work/root-real', '/work/other-real'],
    additionalReadRoots: ['/reference/real'],
  });
  assert.equal(settings.hooks.Stop[0].hooks[0].type, 'command');
  assert.match(settings.hooks.Stop[0].hooks[0].command, /^node '\/state\/dir\/stop-hook\.mjs'$/);
  assert.deepEqual(settings.permissions.allow, [
    'Bash(git add:*)', 'Bash(npm:*)',                     // 显式 bash_prefixes → :* 前缀；postflight 不进 allow（V5'）
    'WebFetch(domain:cloud.langfuse.com)', 'Skill(langfuse)',
  ]);
  assert.deepEqual(settings.permissions.additionalDirectories, ['/work/other-real', '/reference/real']);
  assert.deepEqual(settings.permissions.deny, [
    'Edit(//state/dir/stop-hook.mjs)', 'Edit(//state/dir/**)',
  ]);
  assert.equal(JSON.stringify(settings).includes('disableAllHooks'), false);
});

test('assertLaunchable does not depend on ambient project-settings inspection', () => {
  // launchSpec 用 --setting-sources "" 从加载面移除 user/project/local；受控 --settings 仍作为
  // flagSettings 加载。项目 settings 因而不是判定输入，也不需要竞态扫描器。
  assert.deepEqual(assertLaunchable(hookContract, {
    ...goodProbes,
    projectSettingsWithPermissions: ['/work/root/.claude/settings.local.json'],
  }), { ok: true, reasons: [] });
});

test('postflight verifiers never enter the Bash allow-list (V5\')', () => {
  // 第一波修法（argv.join(' ') 精确命令）双向坏死：['printf','%s','a; touch x'] join 出的
  // Bash(printf %s a; touch x) 在 shell 语义下授权了第二条命令（over-auth）；['git','diff','a b.txt']
  // join 出的规则与真实 tokenize（'a b.txt' 是一个参数）永不匹配（dead rule）。病根是 argv
  // （execFile 语义）与 Bash specifier（shell 字符串语义）之间没有可靠编码——整条自动推导通道移除。
  // verifier 的执行不受影响：hook 用 execFileSync 跑它，不经 claude 权限；执行体要自己跑 verifier
  // 由作者显式 bash_prefixes 声明。
  const contract = {
    ...hookContract,
    postflight: [
      { id: 'pf', type: 'command', cwd: '/work/root', argv: ['git', 'diff', '--exit-code'] },
      { id: 'pf2', type: 'command', cwd: '/work/root', argv: ['printf', '%s', 'a; touch /tmp/x'] },
    ],
    execution_permissions: { bash_prefixes: ['npm run'] },
  };
  const settings = buildSettings({
    contract, hookScriptPath: '/state/dir/stop-hook.mjs', stateDir: '/state/dir', targetRoots: ['/work/root'],
  });
  // 显式 bash_prefixes 仍是前缀授权（作者明知在声明前缀）；postflight 一条都不出现。
  assert.deepEqual(settings.permissions.allow, ['Bash(npm run:*)']);
});

test('unrepresentable postflight argv never blocks or enters the launch gate (V5\')', () => {
  // postflight 不再投影进权限 DSL，含括号/空格的 verifier 可执行路径既不该让 buildSettings 抛、
  // 也不该让 assertLaunchable false-red（第一波曾遗留 argv[0] 投影在 permissionInputs 里）。
  const contract = {
    ...hookContract,
    postflight: [{ id: 'pf', type: 'command', cwd: '/work/root', argv: ['/Applications/App (1).app/bin/check', 'a b.txt'] }],
  };
  const settings = buildSettings({
    contract, hookScriptPath: '/state/dir/stop-hook.mjs', stateDir: '/state/dir', targetRoots: ['/work/root'],
  });
  assert.deepEqual(settings.permissions.allow, []);
  const probes = { ...goodProbes, settings };
  assert.deepEqual(assertLaunchable(contract, probes), { ok: true, reasons: [] });
});

test('buildSettings shell-escapes hostile paths with POSIX single quotes', () => {
  const hostile = buildSettings({ hookScriptPath: "/tmp/a$b`c'd/stop-hook.mjs", stateDir: '/tmp/a$b`c\'d' });
  assert.equal(hostile.hooks.Stop[0].hooks[0].command, "node '/tmp/a$b`c'\\''d/stop-hook.mjs'");
});

test('buildSettings rejects every unrepresentable value interpolated into permission rules', () => {
  const cases = [
    { hookScriptPath: '/state/bad)/stop-hook.mjs', stateDir: '/state/dir', targetRoots: ['/work/root'] },
    { hookScriptPath: '/state/dir/stop-hook.mjs', stateDir: '/state/bad)', targetRoots: ['/work/root'] },
    {
      contract: { ...hookContract, execution_permissions: { bash_prefixes: ['safe) Bash(evil'] } },
      hookScriptPath: '/state/dir/stop-hook.mjs', stateDir: '/state/dir', targetRoots: ['/work/root'],
    },
  ];
  for (const input of cases) {
    assert.throws(() => buildSettings(input), /permission specifier/i);
  }
});

const goodProbes = Object.freeze({
  contractHash: 'a'.repeat(64), confirmedHash: 'a'.repeat(64), baselineDigestStored: true,
  claudeVersion: '2.1.223',
  claudeSessionIdFlag: true,
  claudeSettingSourcesFlag: true,
  settings: buildSettings({
    contract: hookContract, hookScriptPath: '/state/dir/stop-hook.mjs', stateDir: '/state/dir',
    targetRoots: ['/work/root'],
  }),
  hookScript: { path: '/state/dir/stop-hook.mjs', exists: true, sha256: 'f'.repeat(64), mode: '0500' },
  expectedHookSha256: 'f'.repeat(64),
  targetRoots: ['/work/root'],
  stateDir: '/state/dir',
});

test('assertLaunchable dedups target roots the same way buildSettings does (V1)', () => {
  // 重复/symlink 等价的 canonical target root（validateContract 不去重、不规范化，能过校验）：
  // buildSettings 用 unique(T).slice(1)，assertLaunchable 曾用 T.slice(1) 再 unique，两者对
  // 重复首根给出不同 additionalDirectories，合法 contract 每次 launch 都红、永久拒绝。
  const roots = ['/work/root', '/work/root', '/work/extra'];
  const settings = buildSettings({
    contract: hookContract, hookScriptPath: '/state/dir/stop-hook.mjs', stateDir: '/state/dir',
    targetRoots: roots,
  });
  const probes = { ...goodProbes, settings, targetRoots: roots };
  assert.deepEqual(assertLaunchable(hookContract, probes), { ok: true, reasons: [] });
});

test('launchSpec/resumeSpec are pure argv data with settings pinned', () => {
  const spec = launchSpec({
    prompt: 'OBJECTIVE TEXT', settingsPath: '/state/dir/settings.json', cwd: '/work/root', sessionId: 'sid-launch',
  });
  assert.deepEqual(spec.argv, ['claude', '-p', 'OBJECTIVE TEXT', '--output-format', 'json',
    '--session-id', 'sid-launch',
    '--setting-sources', '',
    '--settings', '/state/dir/settings.json', '--permission-mode', 'acceptEdits',
    '--max-turns', String(DEFAULT_MAX_TURNS)]);
  const resume = resumeSpec({ sessionId: 'sid-1', settingsPath: '/state/dir/settings.json',
    diagnosticText: 'fix pf-test', cwd: '/work/root' });
  assert.ok(resume.argv.includes('--resume') && resume.argv.includes('sid-1'));
  assert.ok(resume.argv.includes('--settings'));   // S3：resume 不带 settings 则 hook 静默失效
});

test('explicit Claude turn budgets can raise the default up to a hard preflight ceiling', () => {
  const argvOf = (spec) => spec.argv[spec.argv.indexOf('--max-turns') + 1];
  assert.equal(DEFAULT_MAX_TURNS, 50);
  assert.equal(MAX_TURNS_CEILING, 200);
  for (const notUserGiven of [undefined, { max_turns: 5 }, { user_provided: true, max_minutes: 30 }]) {
    assert.equal(
      argvOf(launchSpec({ prompt: 'p', settingsPath: '/s.json', cwd: '/w', budget: notUserGiven })),
      String(DEFAULT_MAX_TURNS),
    );
  }
  for (const max_turns of [5, 50, 51, 200, 201]) {
    const budget = { user_provided: true, max_turns };
    assert.equal(argvOf(launchSpec({ prompt: 'p', settingsPath: '/s.json', cwd: '/w', budget })), String(max_turns));
    assert.equal(argvOf(resumeSpec({
      sessionId: 'sid-1', settingsPath: '/s.json', diagnosticText: 'd', cwd: '/w', budget,
    })), String(max_turns));
  }

  for (const max_turns of [50, 51, 200]) {
    assert.deepEqual(assertLaunchable({ ...hookContract, budget: { user_provided: true, max_turns } }, goodProbes),
      { ok: true, reasons: [] });
  }
  const over = assertLaunchable({
    ...hookContract, budget: { user_provided: true, max_turns: 201 },
  }, goodProbes);
  assert.equal(over.ok, false);
  assert.ok(over.reasons.some((reason) => reason.includes('200')));
});

test('assertLaunchable passes the good probe set and fails each broken one', () => {
  assert.deepEqual(assertLaunchable(hookContract, goodProbes), { ok: true, reasons: [] });
  const broken = [
    { ...goodProbes, confirmedHash: 'b'.repeat(64) },
    { ...goodProbes, baselineDigestStored: false },
    { ...goodProbes, claudeVersion: '2.1.222' },                      // 低于实测下限的旧版本
    { ...goodProbes, claudeSessionIdFlag: false },                    // --help 探测不到 --session-id
    { ...goodProbes, claudeSettingSourcesFlag: false },               // 隔离环境 settings 的能力缺失
    (() => { const p = { ...goodProbes }; delete p.claudeSessionIdFlag; return p; })(),  // 旧 probes.json 缺探测值
    { ...goodProbes, settings: { ...goodProbes.settings, disableAllHooks: true } },
    { ...goodProbes, settings: { hooks: goodProbes.settings.hooks, permissions: { deny: [] } } },  // 缺 deny
    { ...goodProbes, hookScript: { ...goodProbes.hookScript, exists: false } },
    { ...goodProbes, hookScript: { ...goodProbes.hookScript, sha256: '0'.repeat(64) } },           // hook 被篡改
    { ...goodProbes, hookScript: { ...goodProbes.hookScript, mode: '0755' } },
    { ...goodProbes, hookScript: { ...goodProbes.hookScript, path: '/work/root/stop-hook.mjs' } }, // hook 落进 target root
    { ...goodProbes, targetRoots: ['/state'] },   // 只触发 target-root 判定——隔离用例,不连带 deny(T3 review 补)
  ];
  for (const probes of broken) {
    const verdict = assertLaunchable(hookContract, probes);
    assert.equal(verdict.ok, false);
    assert.ok(verdict.reasons.length > 0);
  }
});

test('every authorized root must be disjoint from controller state (V6\')', () => {
  // target_roots 与 additional_read_roots 都是执行体可达面。任一根与 stateDir 有包含关系，执行体
  // （与控制器同 uid，0600 挡不住）就能读 hook-env.json。根目录 / 是最强反例，必须命中同一判据。
  const cases = [
    ['/', 'the filesystem root'],
    ['/state', 'an ancestor of the state dir'],
    ['/state/dir', 'the state dir itself'],
    ['/state/dir/attempts', 'a directory inside the state dir'],
  ];
  for (const [root, label] of cases) {
    const settings = buildSettings({
      contract: hookContract, hookScriptPath: '/state/dir/stop-hook.mjs', stateDir: '/state/dir',
      targetRoots: ['/work/root'], additionalReadRoots: [root],
    });
    const verdict = assertLaunchable(hookContract, {
      ...goodProbes, settings, additionalReadRoots: [root],
    });
    assert.equal(verdict.ok, false, `${label} must be rejected`);
    assert.ok(verdict.reasons.some((reason) => reason.includes('authorized root overlaps')), label);
  }
  const targetInsideState = '/state/dir/work';
  const targetSettings = buildSettings({
    contract: hookContract, hookScriptPath: '/state/dir/stop-hook.mjs', stateDir: '/state/dir',
    targetRoots: [targetInsideState], additionalReadRoots: [],
  });
  const targetVerdict = assertLaunchable(hookContract, {
    ...goodProbes, settings: targetSettings, targetRoots: [targetInsideState], additionalReadRoots: [],
  });
  assert.equal(targetVerdict.ok, false);
  assert.ok(targetVerdict.reasons.some((reason) => reason.includes('authorized root overlaps')));
  // 与 controller state 无关的读根照常放行。
  const harmless = buildSettings({
    contract: hookContract, hookScriptPath: '/state/dir/stop-hook.mjs', stateDir: '/state/dir',
    targetRoots: ['/work/root'], additionalReadRoots: ['/reference/data'],
  });
  assert.deepEqual(assertLaunchable(hookContract, {
    ...goodProbes, settings: harmless, additionalReadRoots: ['/reference/data'],
  }), { ok: true, reasons: [] });
});

test('assertLaunchable independently rejects a direct-call permission DSL bypass', () => {
  const hostileContract = {
    ...hookContract,
    execution_permissions: { bash_prefixes: ['safe) Bash(evil'] },
  };
  const hostileSettings = structuredClone(goodProbes.settings);
  hostileSettings.permissions.allow = [
    'Bash(npm:*)', 'Bash(test:*)', 'Bash(safe) Bash(evil:*)',
  ];
  const verdict = assertLaunchable(hostileContract, { ...goodProbes, settings: hostileSettings });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.reasons.some((reason) => reason.includes('permission specifier')));

  const hostilePath = assertLaunchable(hookContract, {
    ...goodProbes,
    stateDir: '/state/bad)',
  });
  assert.equal(hostilePath.ok, false);
  assert.ok(hostilePath.reasons.some((reason) => reason.includes('permission specifier')));
});

// 版本闸是下限不是精确 allowlist：精确 allowlist 每次 claude 升版都会挡下合法 launch（2026-08-09
// 真实触发：2.1.225 上线，allowlist 只有 2.1.223），而它想挡的 envelope 漂移由上面那道 21-key 直检
// 直接负责。下限只排除已知过旧的版本。
test('the claude version gate is a floor: older rejects, equal and newer launch', () => {
  const withVersion = (claudeVersion) => assertLaunchable(hookContract, { ...goodProbes, claudeVersion });

  // ① 低于下限：拒，且 reason 说明至少要哪个版本（操作员据此知道要升到哪儿）。
  const tooOld = withVersion('2.1.222');
  assert.equal(tooOld.ok, false);
  assert.ok(tooOld.reasons.some((reason) => reason.includes('2.1.223')),
    'the reason must name the minimum version');

  // ② 等于下限放行；③ 高于下限放行（2.1.225 是触发这次改动的真实版本）。
  for (const ok of ['2.1.223', '2.1.225', '2.2.0', '3.0.0']) {
    assert.deepEqual(withVersion(ok), { ok: true, reasons: [] }, `${ok} must launch`);
  }
  // launch.mjs 采集器拿到的原样 --version 输出带后缀，这类形态也要解析得出来。
  assert.deepEqual(withVersion('2.1.223 (Claude Code)'), { ok: true, reasons: [] });
  assert.deepEqual(withVersion('2.1.225 (Claude Code)\n'), { ok: true, reasons: [] });

  // ④ 解析不出来 → 拒，不是放行（null 是采集器在 --version 输出不含三段数字时的取值）。
  for (const unreadable of [null, undefined, '', 'unknown', '2.1', 'v2', 223, { major: 2 }]) {
    const verdict = withVersion(unreadable);
    assert.equal(verdict.ok, false, `${String(unreadable)} must not launch`);
    assert.ok(verdict.reasons.some((reason) => reason.includes('2.1.223')));
  }

  // ⑤ 逐段数值比较，不是字典序：字典序会把 2.1.9 / 2.1.10 判成不低于 2.1.223（放行旧版本），
  // 又会把 2.1.1000 判成更旧（误杀新版本）——两个方向都要咬。
  assert.equal(withVersion('2.1.9').ok, false, '2.1.9 is older than 2.1.223');
  assert.equal(withVersion('2.1.10').ok, false, '2.1.10 is older than 2.1.223');
  assert.deepEqual(withVersion('2.1.1000'), { ok: true, reasons: [] });
});

// static.test.mjs 的术语闸钉的是词表，钉不住「下限 vs 白名单」这个语义，也钉不住放松之后
// 丢了什么。文档漂回「新版本须先加入 allowlist」这套旧规定、或用站不住的可观测性声明把缺口
// 盖回去时，这条红。
//
// 复审 F1/F2/F3 的教训写在这里：首版文档声称「hook 协议失效 → hookRuns 计数不涨」「deny 失效
// → permission_denials 里没有本该被拦的写入」，两条都是错的（留痕在 decision 分支之外无条件
// 追加，计数照涨；deny 失效与健康 run 的空数组逐字节相同）。所以这条测试钉的是**否定形**——
// 光断言「文档提到 hookRuns」会被这两句假话轻松满足。
test('the adapter reference documents the floor semantics and the weakening it accepts', async () => {
  const doc = await readFile(new URL('../references/adapters/claude.md', import.meta.url), 'utf8');
  assert.match(doc, /CLAUDE_VERSION_FLOOR/);
  assert.match(doc, /解析不出来一律拒/);
  // 直检的覆盖面要写准：只覆盖 key 集，取值不在其内。
  assert.match(doc, /只覆盖 key 集/);
  assert.match(doc, /人工核对这个取值/);
  // 协议漂移是弱可观测，不得再声称有专门信号指向它。
  assert.match(doc, /弱可观测/);
  assert.match(doc, /没有可用的观测量/);      // deny 面那条是空信号
  // 放松之后真正的安全底是分层防御。
  assert.match(doc, /假 candidate 不等于假 Close/);
  // 旧的规定性语句不得残留——它们说的是「升版即不可用」那套。
  assert.doesNotMatch(doc, /已验证 allowlist|加入 allowlist/);
  // 两条被证伪的可观测性声称不得复活（只咬把信号绑到病因上的说法，不影响正确用法：
  // 「hook 缺席时 hookRuns 不涨」是对的，仍可写）。
  assert.doesNotMatch(doc, /协议[^\n]*计数不涨|计数不涨[^\n]*协议/);
  assert.doesNotMatch(doc, /deny 失效表现为/);
});

// 终审 M7：两条 deny 里此前只核了 hook 脚本那条。护住 hook-runs.jsonl / hook-env.json /
// probes.json 的恰恰是 state 目录那条——它被摘掉时 hook 本体仍完好，前一条闸看不见。
test('assertLaunchable also verifies the state-directory deny rule, not just the hook path one', () => {
  const hookOnlyDeny = {
    ...goodProbes,
    settings: {
      hooks: goodProbes.settings.hooks,
      permissions: {
        ...goodProbes.settings.permissions,
        deny: goodProbes.settings.permissions.deny
          .filter((rule) => rule !== 'Edit(//state/dir/**)'),   // 只摘掉 state 目录那条
      },
    },
  };
  const verdict = assertLaunchable(hookContract, hookOnlyDeny);
  assert.deepEqual(verdict.reasons, ['settings must deny Edit on the whole controller state directory']);

  // stateDir 缺失时拼不出规则，同样落红（fail-closed，不因为字段没给就跳过这条闸）。
  const noStateDir = { ...goodProbes };
  delete noStateDir.stateDir;
  assert.equal(assertLaunchable(hookContract, noStateDir).ok, false);
});

// 终审 I3 修的是行为（此前 contract 声明任何 physical 约束都零核验放行），N1 修的是诊断：旧判据
// 「mechanism 必须逐字点名一条真实生成的 deny 规则」读起来像「改 mechanism 就能过」，实测却是
// **不动点陷阱**——生成的 deny 形如 Edit(/<stateRoot>/<controller>/<contractHash>/**)，要过就得把含
// contractHash 的字符串写进 contract，写进去 hash 就变；何况 stateRoot/controller 是 prepare 的 CLI
// 参数，编译期根本不知道。真因是 claude 侧生成的 deny 只护控制器自己的机件，压根不存在面向用户
// 约束的物理拦截面。行为（一律红）不变，诊断改成直说真因并给出唯一出口 audit_only。
test('assertLaunchable refuses every physical constraint on the claude runtime, whatever its mechanism', () => {
  const withConstraint = (constraint) => assertLaunchable(
    { ...hookContract, constraints: [constraint] }, goodProbes,
  );

  const proxy = withConstraint({
    id: 'c-net',
    enforcement: 'physical',
    rule: 'no network egress',
    mechanism: 'network egress proxy denies all hosts',
    verify: 'inspect proxy access log',
  });
  assert.equal(proxy.ok, false);
  assert.equal(proxy.reasons.length, 1);
  assert.ok(proxy.reasons[0].includes('c-net'));
  assert.ok(proxy.reasons[0].includes('audit_only'), 'the reason must name the one real way out');
  // 诊断不得再把矛头指向 mechanism——那会把作者送进那个永远修不好的循环。
  assert.ok(!proxy.reasons[0].includes('mechanism'), 'the reason must not blame the mechanism wording');

  // 逐字照抄一条真实生成的 deny 规则（旧实现下这是唯一能过的写法，实测 ok:true）现在同样红：
  // 能过才是问题——它诱导作者去写一个含 contractHash 的字符串，而那个 hash 因此永远对不上。
  const quotingDeny = withConstraint({
    id: 'c-state',
    enforcement: 'physical',
    rule: 'the executor may not edit controller state',
    mechanism: 'settings.permissions.deny carries Edit(//state/dir/**)',
    verify: 'read the generated settings.json',
  });
  assert.equal(quotingDeny.ok, false);
  assert.ok(quotingDeny.reasons[0].includes('c-state'));

  // audit_only 不进这条闸（是否物理拦得住本来就不是它的承诺）。
  assert.deepEqual(withConstraint({
    id: 'c-net-audit', enforcement: 'audit_only', rule: 'no network egress',
    mechanism: 'network egress proxy denies all hosts', verify: 'inspect proxy access log',
  }), { ok: true, reasons: [] });
});
