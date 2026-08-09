# goal-condition runtime adapter v2 实现计划（Plan 2）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按 spec v2（`docs/superpowers/specs/2026-08-06-goal-runtime-adapters-v2-design.md`）实现 launch.mjs + 双 runtime adapter + workflow 通道改绑 + 文档/安装闭包同步，全部形状以 7 spike 实测结果（`docs/superpowers/spikes/2026-08-06-goal-runtime-adapters-v2-results.md`）为准。

**Architecture:** Claude 侧 = 裸 `claude -p` + 控制器生成的 Stop hook（JSON decision block 协议）自建确定性续轮 + `--resume` 外环；Codex 侧 = app-server JSON-RPC 全量对接（stdio 直连、`ephemeral:false` thread、`turn/start` 起首轮、六态处置表、threadId+updatedAt+序列号 finalize 归因）。纯函数进 `scripts/lib/adapters/{claude,codex}.mjs`，执行豁口 = `launch.mjs` CLI + codex.mjs 的 `GoalRpcClient`。

**Tech Stack:** Node ≥20 ESM、node:test、既有 contract.mjs/snapshot.mjs/workflow.mjs 不重写只消费。

**范围决策（写计划时锁定）：**
- exec 回退的状态机降级开关**不实现**。spec §3 D3 的 v2 更新明示「降为未来 alpha 协议漂移的预留，不在本轮实现主路径上」；§7 表格残留的降级开关行以 v2 更新为准（此冲突已呈用户，若用户裁定按 §7 实现，另加一个 task）。
- `evidence/pressure-evidence.json` 不动（§10 挂账；其中的 `update_goal`/`get_goal` 属历史实验证据，自带自校验 hash）。
- F6 信任链 re-pin 与 release 发布不在本计划内（§10：re-pin 是 release 前置，实现完成后单独走）。

## Global Constraints

- 分支 `codex/goal-condition-cross-runtime`；不 push、不 merge main。
- 既有 119 测试保持全绿：每个 task 收尾跑 `npm test`（仓库根）。
- 凭证绝不进 git / fixture / 日志。auth-copy 模式：只读复制生产 `~/.codex/auth.json` 到隔离 CODEX_HOME、codexHome 与 work 各自独立 `mkdtemp`（不共父目录）、清理抽幂等 `cleanup()` 由 `finally` 与 `process.on('SIGTERM'/'SIGINT')` 共用。
- 隔离铁律：任何真实 codex 进程必须显式传 CODEX_HOME，缺省 fail-closed throw（不得静默继承生产 `~/.codex`）。
- contract 命令只走 argv（execFile 语义）；不得 `eval`、`sh -c`、拼接 shell 字符串。
- 未知 key 一律 fail-closed：Claude result 21-key 全集校验；Codex goal envelope closed-world（必填 7 key + 可选 `tokenBudget`）。
- Codex RPC 层状态词形是 **camelCase**：`active|paused|blocked|usageLimited|budgetLimited|complete`（sqlite 层的 snake_case 不出现在 adapter 代码）。
- hook block 协议 = stdout JSON `{"decision":"block","reason":"..."}` + exit 0（**非** exit 2）；hook reason 措辞不得与 objective 冲突（只说「未达标、请补 X」）。
- resume 必带 `--settings`（不带则 hook 静默失效，S3 实测）。
- inject method = `thread/inject_items`（下划线）；items = `{type:'message',role:'user',content:[{type:'input_text',text}]}`；inject 不独立驱动执行，必须配显式 `turn/start`。
- goal 必须挂 `ephemeral:false` thread（ephemeral 拒 goal RPC -32600）。
- `thread/goal/set` 之后读 **set 返回的实际 status**，不假定请求即生效。
- finalize 归因 = `threadId` + `updatedAt` + 控制器单调序列号（goal_id RPC 层不可得；updatedAt 秒级会撞值）。
- 穷尽变异纪律：每个生产判定逐条 revert（或改字面量）确认对应测试变红后再恢复；结果记入 task report。
- `references/*.md` 不得含 `/Users/`、`/home/` 路径或凭证样式词（static.test.mjs 私有数据闸会扫）；SKILL.md ≤200 行。
- adapter 常量（测试钉死）：`CLAUDE_VERSION_ALLOWLIST=['2.1.223']`、`MAX_HOOK_BLOCKS=8`、`CLI_MAX_TURNS=50`、`MAX_AUTO_RESUMES=2`、`POLL_INTERVAL_MS=5000`、`WALL_CLOCK_DEADLINE_MS=1800000`。

## File Structure

```
goal-condition-template/
  scripts/launch.mjs                    新增（公开闭包）：CLI + 状态目录/attempt/红项分类 + 两 runtime 执行流程
  scripts/lib/adapters/claude.mjs       新增（公开闭包）：normalizeTerminal/buildStopHook/buildSettings/launchSpec/resumeSpec/assertLaunchable
  scripts/lib/adapters/codex.mjs        新增（公开闭包）：envelope 校验/六态表/normalizeTerminal/resumeRpcOps/finalize 归因 + GoalRpcClient
  scripts/lib/workflow.mjs              改绑 4 处字面量
  scripts/lib/installer.mjs             REQUIRED_CORE_FILES +3
  references/adapters/claude.md         重写（Stop hook 姿态）
  references/adapters/codex.md          重写（app-server 编排姿态）
  SKILL.md、references/run-contract.md  通道名改绑
  tests/adapters-claude.test.mjs        新增
  tests/adapters-codex.test.mjs         新增
  tests/launch.test.mjs                 新增
  tests/fixtures/claude-result-21key.json      新增（取自 spike S3 实测）
  tests/fixtures/codex-goal-envelopes.json     新增（取自 spike S1a/S2b 实测）
  tests/workflow.test.mjs、install.test.mjs、static.test.mjs  同步
README.md                               release member 列表 +3
```

controller state 目录规格（launch.mjs 实现，§7）：`~/.local/state/goal-condition/controllers/<name>/<contract-hash>/`，目录 0700；内含 `stop-hook.mjs`(0500)、`settings.json`、`hook-env.json`(0600)、`probes.json`、`attempts/<n>`（O_EXCL 原子写）、`hook-runs.jsonl`、`hook-blocks.count`、`rpc-envelopes.jsonl`、`goal-set-ledger.jsonl`、`thread.json`、`codex-home.path`、`lease.json`、`turn-counts.json`（Task 10：`turn/started`/`turn/completed` 计数。P-2 之后 `started` 是 turn 跑飞护栏的直接输入，不再只是呈现；六态判定仍全靠 `goal.status`。文件自带 `semantics` 字段说明计数是「控制器观察到的通知数」，成功路径上 `completed = started - 1` 是常态）。

---

### Task 1: Claude adapter — normalizeTerminal（21-key 全集校验 + 4 字段投影）

**Files:**
- Create: `goal-condition-template/scripts/lib/adapters/claude.mjs`
- Create: `goal-condition-template/tests/fixtures/claude-result-21key.json`
- Test: `goal-condition-template/tests/adapters-claude.test.mjs`

**Interfaces:**
- Produces: `CLAUDE_RESULT_KEYS`（21 项 frozen 数组）、`normalizeTerminal(raw) → {ok:true,candidate:{subtype,is_error,terminal_reason,permission_denials}} | {ok:false,reasons:[]}`。candidate 后续直接喂 `workflow.mjs` 的 `runtimeTerminalState('claude', candidate)`。

- [ ] **Step 1: 生成 fixture（真实 envelope，不手写）**

在仓库根执行：

```bash
node --input-type=module -e "
import { readFileSync, writeFileSync } from 'node:fs';
const d = JSON.parse(readFileSync('spikes/goal-runtime-adapters-v2/fixtures/s3-hook-loop.json','utf8'));
writeFileSync('goal-condition-template/tests/fixtures/claude-result-21key.json', JSON.stringify(JSON.parse(d.runA.out), null, 2) + '\n');
"
```

核对：文件 key 数恰为 21，含 `subtype:"success"`、`terminal_reason:"completed"`。

- [ ] **Step 2: 写失败测试**

`tests/adapters-claude.test.mjs`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CLAUDE_RESULT_KEYS, normalizeTerminal } from '../scripts/lib/adapters/claude.mjs';
import { runtimeTerminalState } from '../scripts/lib/workflow.mjs';

const fixtureUrl = new URL('./fixtures/claude-result-21key.json', import.meta.url);
const realResult = JSON.parse(await readFile(fixtureUrl, 'utf8'));

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

test('diagnostics stay privacy-safe: counts only, never raw key names', () => {
  const normalized = normalizeTerminal({ ...realResult, SECRET_LOOKING_KEY: 'x' });
  assert.ok(normalized.reasons.every((reason) => !reason.includes('SECRET_LOOKING_KEY')));
});
```

- [ ] **Step 3: 跑测试确认失败**（模块不存在）：`npm test 2>&1 | grep adapters-claude`
- [ ] **Step 4: 实现**

`scripts/lib/adapters/claude.mjs`：

```js
// Claude runtime adapter 纯函数。执行豁口在 scripts/launch.mjs；本文件不 spawn、不读写盘。
export const CLAUDE_VERSION_ALLOWLIST = Object.freeze(['2.1.223']);

// 2.1.223 实测 result envelope 完整 key 集（spike S3 抓取）。SDK 文档与实现存在字段漂移，
// 以 allowlist 版本的实测集为准；新版本须重跑 S3/S5 实测后才可加入 allowlist。
export const CLAUDE_RESULT_KEYS = Object.freeze([
  'api_error_status', 'duration_api_ms', 'duration_ms', 'fast_mode_disabled_reason',
  'fast_mode_state', 'is_error', 'modelUsage', 'num_turns', 'permission_denials',
  'result', 'session_id', 'stop_reason', 'subtype', 'terminal_reason',
  'time_to_request_ms', 'total_cost_usd', 'ttft_ms', 'ttft_stream_ms', 'type', 'usage', 'uuid',
]);

const EXPECTED_KEYS = new Set(CLAUDE_RESULT_KEYS);

export function normalizeTerminal(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reasons: ['Claude result must be an object'] };
  }
  const actual = Object.keys(raw);
  const missing = CLAUDE_RESULT_KEYS.filter((key) => !Object.hasOwn(raw, key));
  const unknown = actual.filter((key) => !EXPECTED_KEYS.has(key));
  const reasons = [];
  if (missing.length) reasons.push(`Claude result is missing ${missing.length} required key(s)`);
  if (unknown.length) reasons.push(`Claude result contains ${unknown.length} unknown key(s)`);
  if (reasons.length) return { ok: false, reasons };
  return {
    ok: true,
    candidate: {
      subtype: raw.subtype,
      is_error: raw.is_error,
      terminal_reason: raw.terminal_reason,
      permission_denials: raw.permission_denials,
    },
  };
}
```

- [ ] **Step 5: 跑测试确认通过**：`npm test`
- [ ] **Step 6: 变异纪律**：把实现里 `unknown.length` 判定临时删掉 → 对应测试必须变红；恢复。把 `CLAUDE_RESULT_KEYS` 临时删一项 → fixture 对齐测试变红；恢复。结果记 report。
- [ ] **Step 7: Commit**

```bash
git add goal-condition-template/scripts/lib/adapters/claude.mjs goal-condition-template/tests/adapters-claude.test.mjs goal-condition-template/tests/fixtures/claude-result-21key.json
git commit -m "feat(adapter): claude normalizeTerminal——21-key 全集校验 + 4 字段投影（实测 fixture）"
```

---

### Task 2: Claude adapter — buildStopHook + buildSettings（hook 生成器）

**Files:**
- Modify: `goal-condition-template/scripts/lib/adapters/claude.mjs`
- Test: `goal-condition-template/tests/adapters-claude.test.mjs`

**Interfaces:**
- Consumes: contract 的 `postflight` command entries（`{id,type:'command',cwd,argv,requires_env?,capture?}`）。
- Produces: `MAX_HOOK_BLOCKS=8`、`buildStopHook({contract,stateDir}) → {script}`（生成 `stop-hook.mjs` 的完整文本）、`buildSettings({hookScriptPath,stateDir}) → settings 对象`。Task 8 的 prepare 负责落盘（hook 0500、settings JSON）。

设计（spec §5「Stop hook」节逐条对应）：
- hook 是**新组件**，语义=达标判定：逐条 `execFileSync` 跑 postflight entry、逐条记 exit code、多条红**收集不抛**；与 preflight `captureCommand`（不变性语义、非零即抛）无复用关系。红 = 非零退出（entry 无 expected 字段——这条也要写进 adapter 文档，Task 12）。
- 全绿 → allow（exit 0 无输出）。有红且 block 计数 < `MAX_HOOK_BLOCKS`、且未超用户时间预算 → stdout `{"decision":"block","reason":...}` + exit 0。超 block 计数或超时间预算 → allow 放行停机（候选=未达由控制器 postflight 兜底）。
- reason 措辞与 objective 兼容（S3 死循环教训）：固定模板 `postflight not green yet: <红 id 列表>. Continue working toward the original objective, make these checks pass, then finish.`——不得出现与任务目标矛盾的表述。
- 每次执行 append 一行 JSON 到 `<stateDir>/hook-runs.jsonl`（`{ts,reds,decision}`）；block 计数持久化在 `<stateDir>/hook-blocks.count`。控制器 postflight 用运行行数 ≥ attempt 轮数验证 hook 未静默缺席（helper 在 Task 8）。
- entry 命令经 `execFileSync(argv[0], argv.slice(1), {cwd, env})` 执行——argv 语义，无 shell 字符串。env = `process.env` 合并 `<stateDir>/hook-env.json`（若存在；prepare 从 requires_env 生成，0600）。
- 生成物是把 entries 投影（只留 id/cwd/argv）JSON.stringify 后内嵌进模板的自含 .mjs；stateDir 以 JSON 字面量内嵌。
- 时间预算：仅 `contract.budget.user_provided && contract.budget.max_minutes` 存在时生效——生成脚本内嵌 `maxWallMs`，首次运行把 `startedAt` 写 `<stateDir>/hook-started-at`，超时 allow 放行。budget 缺席时无时间上限（预算仅用户明给）。
- 用户 `max_turns` 存在时取 `min(MAX_HOOK_BLOCKS, contract.budget.max_turns)` 为 block 上限。

- [ ] **Step 1: 写失败测试**（追加到 `adapters-claude.test.mjs`）

```js
import { buildStopHook, buildSettings, MAX_HOOK_BLOCKS } from '../scripts/lib/adapters/claude.mjs';

const hookContract = {
  objective: 'demo',
  budget: { user_provided: true, max_minutes: 30, max_turns: 5 },
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

test('buildSettings wires Stop hook and denies Edit on the hook and state dir', () => {
  const settings = buildSettings({ hookScriptPath: '/state/dir/stop-hook.mjs', stateDir: '/state/dir' });
  assert.equal(settings.hooks.Stop[0].hooks[0].type, 'command');
  assert.match(settings.hooks.Stop[0].hooks[0].command, /^node '\/state\/dir\/stop-hook\.mjs'$/);
  // shell 元字符路径必须被 POSIX 单引号转义包住（$、反引号在双引号域会被 shell 展开）
  const hostile = buildSettings({ hookScriptPath: "/tmp/a$b`c'd/stop-hook.mjs", stateDir: '/tmp/a$b`c\'d' });
  assert.equal(hostile.hooks.Stop[0].hooks[0].command, "node '/tmp/a$b`c'\\''d/stop-hook.mjs'");
  assert.ok(settings.permissions.deny.includes('Edit(//state/dir/stop-hook.mjs)'));
  assert.ok(settings.permissions.deny.includes('Edit(//state/dir/**)'));
  assert.equal(JSON.stringify(settings).includes('disableAllHooks'), false);
});
```

- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**（追加到 `claude.mjs`）

```js
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
  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: 'postflight not green yet: ' + reds.join(', ')
      + '. Continue working toward the original objective, make these checks pass, then finish.',
  }));
}
process.exit(0);
`;
  return { script };
}

// hook command 字段会被 Claude Code 经 shell 解释——必须用 POSIX 单引号转义,
// JSON.stringify 的双引号域对 $ 与反引号不安全（T2 review 实测:双引号域路径直接 shell 语法错误/可注入）。
function shellSingleQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildSettings({ hookScriptPath, stateDir }) {
  return {
    hooks: { Stop: [{ hooks: [{ type: 'command', command: `node ${shellSingleQuote(hookScriptPath)}` }] }] },
    // S5 实测：Edit deny 对简单 Bash 重定向也有效（permission_denials 实录 tool_name:Bash），
    // 但精确上限（语义级 vs 字面匹配）INCONCLUSIVE——不宣称完全物理保证。
    // deny 路径必须是 realpath 规范形（/var/folders vs /private/var/folders 的字面失配会让 deny 落空）。
    permissions: { deny: [`Edit(/${hookScriptPath})`, `Edit(/${stateDir}/**)`] },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**；**Step 5: 变异纪律**：模板里 `decision: 'block'` 改成 exit 2 形态 → 协议测试红；`maxBlocks` 计算去掉 `Math.min` → 预算映射测试红；恢复。
- [ ] **Step 6: Commit** `feat(adapter): claude Stop hook 生成器——JSON decision 协议 + 多红收集 + 预算内嵌`

---

### Task 3: Claude adapter — launchSpec / resumeSpec / assertLaunchable

**Files:**
- Modify: `goal-condition-template/scripts/lib/adapters/claude.mjs`
- Test: `goal-condition-template/tests/adapters-claude.test.mjs`

**Interfaces:**
- Produces: `CLI_MAX_TURNS=50`、`launchSpec({prompt,settingsPath,cwd}) → {argv,settingsPath,cwd,env_names}`、`resumeSpec({sessionId,settingsPath,diagnosticText,cwd}) → 同形`、`assertLaunchable(contract, probes) → {ok,reasons[]}`。
- Consumes（Task 8 生产的 probes 形状，assertLaunchable 只判不采）：

```js
probes = {
  contractHash, confirmedHash,          // 均为 64hex；由调用方计算/记录
  baselineDigestStored,                 // boolean：digest 已外存可信编排状态
  claudeVersion,                        // 'claude --version' 解析出的 x.y.z（原始输出已落盘 probes.json）
  settings,                             // 生成 settings 的解析对象
  hookScript: { path, exists, sha256, mode },   // 落盘后 lstat/hash 观测；mode 为 '0500' 形式
  expectedHookSha256,                   // buildStopHook 产物 script 的 sha256
  targetRoots,                          // contract.target_roots
}
```

- [ ] **Step 1: 写失败测试**

```js
import { assertLaunchable, launchSpec, resumeSpec, CLI_MAX_TURNS } from '../scripts/lib/adapters/claude.mjs';

const goodProbes = Object.freeze({
  contractHash: 'a'.repeat(64), confirmedHash: 'a'.repeat(64), baselineDigestStored: true,
  claudeVersion: '2.1.223',
  settings: buildSettings({ hookScriptPath: '/state/dir/stop-hook.mjs', stateDir: '/state/dir' }),
  hookScript: { path: '/state/dir/stop-hook.mjs', exists: true, sha256: 'f'.repeat(64), mode: '0500' },
  expectedHookSha256: 'f'.repeat(64),
  targetRoots: ['/work/root'],
});

test('launchSpec/resumeSpec are pure argv data with settings pinned', () => {
  const spec = launchSpec({ prompt: 'OBJECTIVE TEXT', settingsPath: '/state/dir/settings.json', cwd: '/work/root' });
  assert.deepEqual(spec.argv, ['claude', '-p', 'OBJECTIVE TEXT', '--output-format', 'json',
    '--settings', '/state/dir/settings.json', '--permission-mode', 'acceptEdits',
    '--max-turns', String(CLI_MAX_TURNS)]);
  const resume = resumeSpec({ sessionId: 'sid-1', settingsPath: '/state/dir/settings.json',
    diagnosticText: 'fix pf-test', cwd: '/work/root' });
  assert.ok(resume.argv.includes('--resume') && resume.argv.includes('sid-1'));
  assert.ok(resume.argv.includes('--settings'));   // S3：resume 不带 settings 则 hook 静默失效
});

test('assertLaunchable passes the good probe set and fails each broken one', () => {
  assert.deepEqual(assertLaunchable(hookContract, goodProbes), { ok: true, reasons: [] });
  const broken = [
    { ...goodProbes, confirmedHash: 'b'.repeat(64) },
    { ...goodProbes, baselineDigestStored: false },
    { ...goodProbes, claudeVersion: '2.1.224' },                      // allowlist 外版本
    { ...goodProbes, settings: { ...goodProbes.settings, disableAllHooks: true } },
    { ...goodProbes, settings: { hooks: goodProbes.settings.hooks, permissions: { deny: [] } } },  // 缺 deny
    { ...goodProbes, hookScript: { ...goodProbes.hookScript, exists: false } },
    { ...goodProbes, hookScript: { ...goodProbes.hookScript, sha256: '0'.repeat(64) } },           // hook 被篡改
    { ...goodProbes, hookScript: { ...goodProbes.hookScript, mode: '0755' } },
    { ...goodProbes, hookScript: { ...goodProbes.hookScript, path: '/work/root/stop-hook.mjs' } }, // hook 落进 target root(复合:也触发 deny)
    { ...goodProbes, targetRoots: ['/state'] },   // 只触发 target-root 判定——隔离用例,不连带 deny(T3 review 补)
  ];
  for (const probes of broken) {
    const verdict = assertLaunchable(hookContract, probes);
    assert.equal(verdict.ok, false);
    assert.ok(verdict.reasons.length > 0);
  }
});
```

- [ ] **Step 2: 跑测试确认失败**；**Step 3: 实现**

```js
export const CLI_MAX_TURNS = 50;

export function launchSpec({ prompt, settingsPath, cwd }) {
  // prompt 由调用方从权限受控文件 bytes 读出、单 argv 传入（现行规则）；本函数纯数据不执行。
  return {
    argv: ['claude', '-p', prompt, '--output-format', 'json', '--settings', settingsPath,
      '--permission-mode', 'acceptEdits', '--max-turns', String(CLI_MAX_TURNS)],
    settingsPath, cwd, env_names: [],
  };
}

export function resumeSpec({ sessionId, settingsPath, diagnosticText, cwd }) {
  return {
    argv: ['claude', '-p', diagnosticText, '--resume', sessionId, '--output-format', 'json',
      '--settings', settingsPath, '--permission-mode', 'acceptEdits', '--max-turns', String(CLI_MAX_TURNS)],
    settingsPath, cwd, env_names: [],
  };
}

const DIGEST = /^[0-9a-f]{64}$/;

function settingsContainKey(value, forbidden) {
  if (value === null || typeof value !== 'object') return false;
  return Object.keys(value).some((key) => forbidden.includes(key))
    || Object.values(value).some((child) => settingsContainKey(child, forbidden));
}

// contract 形参当前仅保持 adapter 接口对称(codex 侧要用);hash 与 binding 的核验在 workflow.mjs binding 层。
export function assertLaunchable(contract, probes) {
  const reasons = [];
  if (!DIGEST.test(probes?.contractHash ?? '')) reasons.push('contractHash must be lowercase SHA-256');
  if (probes?.confirmedHash !== probes?.contractHash) reasons.push('confirmed hash does not match contract hash');
  if (probes?.baselineDigestStored !== true) reasons.push('baseline digest is not stored in trusted orchestration state');
  if (!CLAUDE_VERSION_ALLOWLIST.includes(probes?.claudeVersion)) {
    reasons.push('claude version is not in the verified allowlist');
  }
  if (settingsContainKey(probes?.settings, ['disableAllHooks', 'allowManagedHooksOnly'])) {
    reasons.push('settings must not disable or restrict hooks');
  }
  const hook = probes?.hookScript;
  const deny = probes?.settings?.permissions?.deny ?? [];
  if (!hook?.exists) reasons.push('hook script is not on disk in controller state');
  if (hook?.sha256 !== probes?.expectedHookSha256) reasons.push('hook script bytes do not match the generated script');
  if (hook?.mode !== '0500') reasons.push('hook script mode must be 0500');
  if (!deny.includes(`Edit(/${hook?.path})`)) reasons.push('settings must deny Edit on the hook script path');
  if ((probes?.targetRoots ?? []).some((root) => typeof hook?.path === 'string' && hook.path.startsWith(`${root}/`))) {
    reasons.push('hook script must live outside every target root');
  }
  return { ok: reasons.length === 0, reasons };
}
```

- [ ] **Step 4: 跑测试确认通过**；**Step 5: 变异纪律**（逐条 revert 判定确认红：allowlist 判定、deny 判定、sha 判定至少三条）；**Step 6: Commit** `feat(adapter): claude launchSpec/resumeSpec/assertLaunchable——版本 allowlist + hook 完整性 + deny 核验`

---

### Task 4: Codex adapter — goal envelope 校验 + 六态处置 + normalizeTerminal

**Files:**
- Create: `goal-condition-template/scripts/lib/adapters/codex.mjs`
- Create: `goal-condition-template/tests/fixtures/codex-goal-envelopes.json`
- Test: `goal-condition-template/tests/adapters-codex.test.mjs`

**Interfaces:**
- Produces: `GOAL_ENVELOPE_REQUIRED_KEYS`（7 项）、`GOAL_ENVELOPE_OPTIONAL_KEYS=['tokenBudget']`、`GOAL_STATUSES`（camelCase 六态）、`NOTIFICATION_METHODS`（S2 实测 12 个）、`TURN_BOUNDARY_METHODS=['turn/started','turn/completed']`、`validateGoalEnvelope(goal) → {ok,reasons}`、`goalDisposition(status) → {next, candidate?}`、`normalizeTerminal(goal) → {kind:'candidate'|'poll'|'terminal_report'|'reject', ...}`。
- candidate 形状恒为 `{status:'ready_for_postflight', remaining_work:false}`（workflow.mjs 候选态检查零改动）。

- [ ] **Step 1: 生成 fixture（真实 envelope）**

```bash
node --input-type=module -e "
import { readFileSync, writeFileSync } from 'node:fs';
const s1a = JSON.parse(readFileSync('spikes/goal-runtime-adapters-v2/fixtures/s1a-set-complete.json','utf8'));
const s2b = JSON.parse(readFileSync('spikes/goal-runtime-adapters-v2/fixtures/s2b-budget-recovery.json','utf8'));
writeFileSync('goal-condition-template/tests/fixtures/codex-goal-envelopes.json',
  JSON.stringify({ s1a, s2b }, null, 2) + '\n');
"
```

落盘前检查 fixture 无凭证样式内容：`grep -iE 'token\"|bearer|auth' goal-condition-template/tests/fixtures/codex-goal-envelopes.json`——只允许 `tokenBudget`/`tokensUsed` 字段名命中。若 s1a/s2b 原始 fixture 结构与上面取用路径不符（写测试时以真实结构为准），在测试里按实际 JSON path 取 goal 对象，不改 fixture 内容。

- [ ] **Step 2: 写失败测试**

`tests/adapters-codex.test.mjs`：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  GOAL_ENVELOPE_REQUIRED_KEYS, GOAL_STATUSES, NOTIFICATION_METHODS, TURN_BOUNDARY_METHODS,
  validateGoalEnvelope, goalDisposition, normalizeTerminal,
} from '../scripts/lib/adapters/codex.mjs';
import { runtimeTerminalState } from '../scripts/lib/workflow.mjs';

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
```

- [ ] **Step 3: 跑测试确认失败**；**Step 4: 实现**

`scripts/lib/adapters/codex.mjs`：

```js
// Codex runtime adapter：纯函数 + GoalRpcClient（唯一执行豁口，Task 6）。
// 全部形状来自 2026-08-06 spike 实测（codex-cli 0.146.0-alpha.9.2）。

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
```

- [ ] **Step 5: 跑测试确认通过**；**Step 6: 变异纪律**：六态表把 `usageLimited` 挪进 poll 分支 → 处置表测试红；`ALLOWED_KEYS` 加入 `'goalId'` → 未知 key 测试红；恢复。
- [ ] **Step 7: Commit** `feat(adapter): codex envelope closed-world 校验 + 六态处置表 + normalizeTerminal（实测 fixture）`

---

### Task 5: Codex adapter — resumeRpcOps + finalize 归因（threadId+updatedAt+序列号）

**Files:**
- Modify: `goal-condition-template/scripts/lib/adapters/codex.mjs`
- Test: `goal-condition-template/tests/adapters-codex.test.mjs`

**Interfaces:**
- Produces: `assertSetReturnedStatus(setEnvelope, expected) → {ok,observed,reasons}`、`resumeRpcOps({threadId,diagnosticText,tokenBudget?}) → ops[]`、`verifyFinalizeAttribution({setEnvelope,readbackEnvelope,threadId,sequence,ledger}) → {ok,reasons}`。
- ledger 形状（Task 10/11 的执行侧写入 `goal-set-ledger.jsonl`，每行一条）：`{sequence, requestedStatus, updatedAt, threadId}`；sequence 从 1 起、每次 `thread/goal/set` 调用前分配、严格 +1。

- [ ] **Step 0: thread/resume 参数形状核对（零成本静态核对，写进 report）**

```bash
OUT=$(mktemp -d)/schema && codex app-server generate-json-schema --out "$OUT" --experimental \
  && grep -rl 'ThreadResume' "$OUT" | head -3 && cat "$OUT"/*ThreadResumeParams* 2>/dev/null
```

预期 `ThreadResumeParams` 含 `threadId`。若形状不同（如需要额外字段），把实测形状记入 report 并按实测写 Task 11 的 `threadResume`；不臆测。

- [ ] **Step 1: 写失败测试**

```js
import { assertSetReturnedStatus, resumeRpcOps, verifyFinalizeAttribution } from '../scripts/lib/adapters/codex.mjs';

// S2b 实测：set 响应自身如实返回被拒 status（budgetLimited），不撒谎但也不等于请求生效。
test('assertSetReturnedStatus reads the actual returned status', () => {
  const accepted = { result: { goal: { ...completeGoal, status: 'active' } } };
  const refused = { result: { goal: { ...completeGoal, status: 'budgetLimited' } } };
  assert.equal(assertSetReturnedStatus(accepted, 'active').ok, true);
  const verdict = assertSetReturnedStatus(refused, 'active');
  assert.equal(verdict.ok, false);
  assert.equal(verdict.observed, 'budgetLimited');
  assert.equal(assertSetReturnedStatus({ result: {} }, 'active').ok, false);   // envelope 缺失 fail closed
});

test('resumeRpcOps is set-active, inject message item, then explicit turn/start', () => {
  const ops = resumeRpcOps({ threadId: 't-1', diagnosticText: 'pf-test failed: exit 1' });
  assert.deepEqual(ops.map((op) => op.method), ['thread/goal/set', 'thread/inject_items', 'turn/start']);
  assert.deepEqual(ops[0].params, { threadId: 't-1', status: 'active' });
  assert.equal(ops[0].expectStatus, 'active');
  // items 必须是 Responses API message item 形状（S4：UserInput 形状 RPC 不报错但对模型无效）
  assert.deepEqual(ops[1].params.items, [{
    type: 'message', role: 'user', content: [{ type: 'input_text', text: 'pf-test failed: exit 1' }],
  }]);
  assert.equal(ops[2].params.threadId, 't-1');
  assert.equal(ops[2].params.input[0].type, 'text');
  // 抬预算只在显式传入时出现（用户确认前置由调用方保证）
  const raised = resumeRpcOps({ threadId: 't-1', diagnosticText: 'x', tokenBudget: 58291 });
  assert.equal(raised[0].params.tokenBudget, 58291);
});

test('finalize attribution needs threadId + updatedAt + monotonic sequence', () => {
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
    { readbackEnvelope: { result: { goal: { ...goal, threadId: 't-2' } } } },              // threadId 不一致
    { readbackEnvelope: { result: { goal: { ...goal, updatedAt: 1786000452 } } } },        // updatedAt 不绑定
    { readbackEnvelope: { result: { goal: { ...goal, status: 'active' } } } },             // readback 不等于目标态
    { sequence: 3 },                                                                        // 序列号与 ledger 不符
    { ledger: [ledger[0], { ...ledger[1], sequence: 4 }] },                                 // 序列不单调
    { setEnvelope: { result: {} } },                                                        // envelope 缺失
  ];
  for (const override of broken) {
    const verdict = verifyFinalizeAttribution({
      setEnvelope, readbackEnvelope, threadId: 't-1', sequence: 2, ledger, ...override,
    });
    assert.equal(verdict.ok, false);
  }
});
```

- [ ] **Step 2: 跑测试确认失败**；**Step 3: 实现**

```js
export function assertSetReturnedStatus(setEnvelope, expected) {
  const goal = setEnvelope?.result?.goal;
  const shape = validateGoalEnvelope(goal);
  if (!shape.ok) return { ok: false, observed: null, reasons: shape.reasons };
  if (goal.status !== expected) {
    return { ok: false, observed: goal.status, reasons: [`set returned status ${goal.status}, expected ${expected}`] };
  }
  return { ok: true, observed: goal.status, reasons: [] };
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
```

- [ ] **Step 4: 跑测试确认通过**；**Step 5: 变异纪律**：`thread/inject_items` 改回连字符 `thread/inject-items` → ops 测试红；`updatedAt` 绑定判定注释掉 → 归因测试红；恢复。
- [ ] **Step 6: Commit** `feat(adapter): codex resumeRpcOps + finalize 三重归因（threadId+updatedAt+序列号）`

---

### Task 6: Codex adapter — GoalRpcClient（controller 独占执行豁口）

**Files:**
- Modify: `goal-condition-template/scripts/lib/adapters/codex.mjs`
- Test: `goal-condition-template/tests/adapters-codex.test.mjs`

**Interfaces:**
- Produces: `class GoalRpcClient`，构造 `{codexHome, cwd, spawnImpl?, onEnvelope?}`；方法 `start() / initialize() / threadStart({sandbox}) / threadResume({threadId}) / turnStart({threadId,text}) / goalSet(params) / goalGet({threadId}) / goalClear({threadId}) / injectItems({threadId,text}) / onNotification(cb) / stop()`。每次请求与响应都回调 `onEnvelope({direction:'request'|'response', envelope})`（Task 10 把它接到 `rpc-envelopes.jsonl` 证据留痕）。
- 信任模型：goalRpc 只有主会话调用，其 envelope 是 finalize receipt / readback 的唯一合法来源（S6 定级可信，caveat 替代进程证据）；执行器输出不得反序列化为任何 controller 证据。

实现要点（从 `spikes/goal-runtime-adapters-v2/lib/appserver-client.mjs` 移植，逐条保留实测修正）：
- line-delimited JSON-RPC over stdio；`spawn('codex', ['app-server', '--listen', 'stdio://'], {cwd, env:{...process.env, CODEX_HOME: codexHome}, stdio:['pipe','pipe','inherit']})`。
- codexHome 缺省 fail-closed throw（隔离铁律）。
- `rpc()` 超时 60s 且 timer `.unref()`（悬空 timer 会把进程挂满 60s，Task 1 spike 实测）。
- `threadStart` **强制** `ephemeral: false`（参数展开后覆盖：`{ sandbox: 'workspace-write', cwd, ...params, ephemeral: false }`——调用方不可覆盖回 true；goal 挂 ephemeral thread 拒 -32600）。threadId 取 `result.thread.id`。
- `initialize` 带 `clientInfo: { name: 'goal-condition-launch', version: '1' }`（必填）。
- `spawnImpl` 可注入（测试用 stub；默认 `node:child_process` 的 spawn）。

- [ ] **Step 1: 写失败测试**（用 PassThrough stub 伪 app-server）

```js
import { PassThrough } from 'node:stream';
import { GoalRpcClient } from '../scripts/lib/adapters/codex.mjs';

function stubSpawn() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const written = [];
  stdin.on('data', (chunk) => {
    for (const line of chunk.toString().trim().split('\n')) {
      const msg = JSON.parse(line);
      written.push(msg);
      stdout.write(`${JSON.stringify({ id: msg.id, result: { thread: { id: 't-stub' }, goal: null } })}\n`);
    }
  });
  const child = { stdin, stdout, kill: () => {} };
  return { child, written, spawnImpl: () => child };
}

test('GoalRpcClient refuses to start without an explicit codexHome', async () => {
  const client = new GoalRpcClient({ cwd: '/x', spawnImpl: () => { throw new Error('must not spawn'); } });
  await assert.rejects(() => client.start(), /CODEX_HOME/);
});

test('threadStart forces ephemeral:false and exact method names are used', async () => {
  const { written, spawnImpl } = stubSpawn();
  const client = new GoalRpcClient({ codexHome: '/iso/home', cwd: '/x', spawnImpl });
  await client.start();
  await client.initialize();
  await client.threadStart({ ephemeral: true });        // 调用方尝试覆盖也必须被钉回 false
  await client.goalSet({ threadId: 't-stub', objective: 'o' });
  await client.goalGet({ threadId: 't-stub' });
  await client.injectItems({ threadId: 't-stub', text: 'd' });
  await client.turnStart({ threadId: 't-stub', text: 'go' });
  const methods = written.map((msg) => msg.method);
  assert.deepEqual(methods, ['initialize', 'thread/start', 'thread/goal/set', 'thread/goal/get',
    'thread/inject_items', 'turn/start']);
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
```

- [ ] **Step 2: 跑测试确认失败**；**Step 3: 实现**（移植 AppServerClient：`_wire` 行分帧、`_pending` map、`onNotification` 广播原样保留；在 `rpc()` 写入前回调 `onEnvelope({direction:'request', envelope})`、resolve 前回调 response；新增各具名方法薄封装——`goalSet(params)` → `rpc('thread/goal/set', params)`、`injectItems` 内部用 Task 5 的 message item 形状、`threadResume({threadId})` → `rpc('thread/resume', {threadId})` 按 Step 0 核对的形状）。
- [ ] **Step 4: 跑测试确认通过**；**Step 5: 变异纪律**：`ephemeral: false` 钉回逻辑去掉 → 测试红；`thread/goal/set` 改 `update_goal` → 方法名测试红；恢复。
- [ ] **Step 6: Commit** `feat(adapter): codex GoalRpcClient——stdio JSON-RPC 执行豁口，ephemeral 钉死 + envelope 留痕`

---

### Task 7: workflow.mjs 通道字面量改绑（4 处）+ 测试同步

**Files:**
- Modify: `goal-condition-template/scripts/lib/workflow.mjs:111-112,123`
- Modify: `goal-condition-template/tests/workflow.test.mjs:24,31`

**Interfaces:**
- Consumes/Produces: `nextAction` 的输入输出结构、候选态检查、通道结构**全部不动**；只改 4 处字面量。行为变更须在 commit message 声明。

- [ ] **Step 1: 先改测试（红）**

`tests/workflow.test.mjs` 两处 fixture 改绑：

```js
// :24 successfulFinalization
  operation: 'thread/goal/set',
// :31 successfulReadback
  source: 'thread/goal/get',
```

并在 `controller evidence fails closed...` 测试的 finalizationReceipt 变异列表里**新增**旧通道名探针（伪造 receipt fault injection）：

```js
    { ...successfulFinalization, operation: 'update_goal' },   // 旧模型侧 tool 名必须被拒
```

runtimeReadback 变异列表里新增：

```js
    { ...successfulReadback, source: 'get_goal' },
```

- [ ] **Step 2: 跑测试确认红**（新 fixture 被现有生产字面量拒绝）
- [ ] **Step 3: 改生产 4 处**

`scripts/lib/workflow.mjs`：

```js
  if (finalizationReceipt?.operation !== 'thread/goal/set') {
    finalization.reasons.push('finalizationReceipt.operation must be thread/goal/set');
  }
```

```js
  if (runtimeReadback?.source !== 'thread/goal/get') readback.reasons.push('runtimeReadback.source must be thread/goal/get');
```

- [ ] **Step 4: `npm test` 全绿**（含 pressure-cases.json——已核实其中无 operation/source 字面量，无需同步）
- [ ] **Step 5: Commit**

```bash
git add goal-condition-template/scripts/lib/workflow.mjs goal-condition-template/tests/workflow.test.mjs
git commit -m "feat(workflow)!: finalize 通道改绑 app-server RPC 名——update_goal→thread/goal/set、get_goal→thread/goal/get（行为变更：旧通道名 receipt/readback 一律拒绝）"
```

---

### Task 8: launch.mjs — controller state 目录 / attempt / 红项分类 / prepare

**Files:**
- Create: `goal-condition-template/scripts/launch.mjs`
- Test: `goal-condition-template/tests/launch.test.mjs`

**Interfaces:**
- Produces（全部具名导出；CLI 仅在 `process.argv[1]` 是本文件时执行）：
  - `MAX_AUTO_RESUMES = 2`（§6：一次逻辑 run = 1 首发 + ≤2 续跑）
  - `stateDirFor({stateRoot, controller='default', contractHash}) → path`（`<stateRoot>/<controller>/<contractHash>`）
  - `initStateDir(dir)`：mkdir 递归、目录 chmod 0700、建 `attempts/` 子目录
  - `nextAttempt(stateDir) → number`：扫 `attempts/` 现有最大序号，`writeFile(attempts/<n+1>, '', {flag:'wx'})` O_EXCL 原子占位；崩溃后按最大序号恢复；`n+1 > 1 + MAX_AUTO_RESUMES` 时 throw（attempt 超限 fault injection 靠它）
  - `classifyPostflightRed(diagnostics) → {resumable:[], terminal:[]}`
  - `hookRunCount(stateDir) → number`（读 `hook-runs.jsonl` 行数；控制器 postflight 用「运行次数 ≥ attempt 轮数」验证 hook 未静默缺席）
  - `prepareClaude({contract, contractPath, stateDir, collect}) → {settingsPath, hookScriptPath, probes}`
- Consumes: Task 2/3 的 `buildStopHook/buildSettings`、`scripts/lib/contract.mjs` 的 `readContract/contractHash`。

红项分类（§6 表，fail-closed 方向：未知 code 归 terminal 不自动续跑）：

```js
const TERMINAL_CODES = [/^CONTEXT_STATE_CHANGED$/, /^GIT_/, /^PERMISSION_/, /^UNAUTHORIZED_/];
export function classifyPostflightRed(diagnostics) {
  const resumable = [];
  const terminal = [];
  for (const diagnostic of diagnostics) {
    const code = diagnostic?.code ?? '';
    if (TERMINAL_CODES.some((pattern) => pattern.test(code))) terminal.push(diagnostic);
    else if (code === 'COMMAND_FAILED' || code === 'ARTIFACT_MISSING') resumable.push(diagnostic);
    else terminal.push(diagnostic);   // 未知 code fail-closed：不自动续跑
  }
  return { resumable, terminal };
}
```

`prepareClaude`（执行侧采集、纯函数判定的分工——采集在这，判定在 adapter）：
1. `initStateDir`；`realpathSync(stateDir)` 得规范路径，后续 hook/deny 全用规范形（S5 的 /var/folders 字面失配教训）。
2. `buildStopHook({contract, stateDir})` → 写 `stop-hook.mjs`，chmod **0500**；记 `expectedHookSha256 = sha256(script)`。
3. requires_env 并集：对每个名字，`process.env[name] === undefined` → throw（缺 env 不静默）；存在则写入 `hook-env.json`（chmod 0600；值只进 state 目录 0700，不进 git/日志）。
4. `buildSettings` → 写 `settings.json`。
5. 采集 probes：`execFile('claude', ['--version'])` 原始输出 + 解析出的 x.y.z；hook 落盘后 `lstat` mode（`(mode & 0o7777).toString(8).padStart(4,'0')`）与 bytes sha256。全部写 `probes.json`（含采集命令与原始输出——spec §5「事先采集并落盘」）。
6. 返回 `{settingsPath, hookScriptPath, probes}`。`collect` 参数注入采集函数集（默认真实 execFile/lstat；测试注入 stub）。

- [ ] **Step 1: 写失败测试**（state helpers + classify + prepareClaude 用临时目录与 stub collect）

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_AUTO_RESUMES, stateDirFor, initStateDir, nextAttempt, classifyPostflightRed,
  hookRunCount, prepareClaude,
} from '../scripts/launch.mjs';

test('nextAttempt is O_EXCL monotonic and refuses beyond 1+MAX_AUTO_RESUMES', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gc-launch-test-'));
  await initStateDir(dir);
  assert.equal(await nextAttempt(dir), 1);
  assert.equal(await nextAttempt(dir), 2);
  assert.equal(await nextAttempt(dir), 3);
  await assert.rejects(() => nextAttempt(dir), /attempt limit/);   // 1 首发 + 2 续跑 = 3 封顶
});

test('state dir is 0700 and layout is per contract hash', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gc-launch-test-'));
  const dir = stateDirFor({ stateRoot: root, contractHash: 'a'.repeat(64) });
  assert.equal(dir, join(root, 'default', 'a'.repeat(64)));
  await initStateDir(dir);
  assert.equal(((await stat(dir)).mode & 0o7777), 0o700);
});

test('red classification is fail-closed: boundary and unknown codes never resume', () => {
  const { resumable, terminal } = classifyPostflightRed([
    { code: 'COMMAND_FAILED', entry: 'pf-test' },
    { code: 'CONTEXT_STATE_CHANGED' },
    { code: 'GIT_REF_CHANGED' },
    { code: 'PERMISSION_DENIAL' },
    { code: 'SOMETHING_NEW' },
  ]);
  assert.deepEqual(resumable.map((d) => d.code), ['COMMAND_FAILED']);
  assert.equal(terminal.length, 4);
});
```

prepareClaude 测试：临时 stateRoot + Task 2 的 `hookContract`（cwd/argv 指向临时目录避免真实副作用）+ stub `collect`（返回固定 `claudeVersion:'2.1.223'` 与原始输出）；断言：hook 文件存在且 mode 0500、settings.json 的 deny 含规范化 hook 路径、`hook-env.json` mode 0600、probes.json 含原始版本输出、requires_env 缺失时 rejects。

- [ ] **Step 2: 跑测试确认失败**；**Step 3: 实现**（CLI 入口同时落地：`prepare --contract F --state-root R [--controller N]` 调 `readContract` → `prepareClaude`（claude）或仅 initStateDir+版本 probes（codex），stdout 打印 JSON 摘要；main 判定 `import.meta.url === pathToFileURL(process.argv[1]).href` 时才跑 CLI）
- [ ] **Step 4: 跑测试确认通过**；**Step 5: 变异纪律**：attempt 上限判定去掉 → 超限测试红；未知 code 分支改 resumable → 分类测试红；恢复。
- [ ] **Step 6: Commit** `feat(launch): controller state 目录 + O_EXCL attempt + fail-closed 红项分类 + claude prepare`

---

### Task 9: launch.mjs — Claude 执行流程（launch / resume）

**Files:**
- Modify: `goal-condition-template/scripts/launch.mjs`
- Test: `goal-condition-template/tests/launch.test.mjs`

**Interfaces:**
- Produces: `runClaudeAttempt({contract, stateDir, prompt, kind:'launch'|'resume', diagnosticText?, execFileImpl?}) → {outcome:'candidate'|'terminal_report', candidate?, reasons?, sessionId?}`；CLI 子命令 `launch --contract F --state D --prompt-file P` 与 `resume --contract F --state D --diagnostics-file P`。
- Consumes: Task 1/3 的 `normalizeTerminal/launchSpec/resumeSpec/assertLaunchable`、Task 8 的 state helpers。

流程（两种 kind 共用）：
1. `nextAttempt(stateDir)`（超限即 throw 终局）。
2. 读 `probes.json` + 现场重新 lstat/hash hook 文件合成完整 probes → `assertLaunchable(contract, probes)`；红 → 不 launch，写终局报告。
3. kind='launch'：`launchSpec({prompt, settingsPath, cwd: contract.target_roots[0]})`；kind='resume'：读 `thread.json` 里存的 `sessionId`（Claude 侧存 session）、`resumeSpec({sessionId, settingsPath, diagnosticText, cwd})`。resume 的 diagnosticText 由调用方只喂 **resumable** 红项（分类在控制器侧先做）。
4. `execFileImpl(argv[0], argv.slice(1), {cwd, maxBuffer: 32*1024*1024})` 捕 stdout → JSON.parse → 原始 result 写 `attempts/<n>-result.json`。**注意** `claude -p` 非零退出/`is_error` 时 stdout 仍是 result JSON——execFile throw 时先尝试从 `error.stdout` 解析，解析不出才按进程失败终局。
5. `normalizeTerminal(raw)`：ok → `candidate.json` 写投影、`thread.json` 记 `sessionId=raw.session_id`，返回 candidate；not ok → 终局报告（reasons 原样带出，`terminal_reason:'max_turns_reached'` 等即「候选=未达」如实标注）。
6. 候选与终局都**不做** postflight——独立 postflight 是主会话的事（协议不变）。

- [ ] **Step 1: 写失败测试**（stub execFileImpl 返回 Task 1 fixture 的 21-key JSON 文本；变体：max_turns 结果、is_error 结果、stdout 非 JSON、execFile throw 带 stdout）：断言 candidate 落盘形状、sessionId 记录、resume 组出的 argv 含 `--resume <sessionId>` 与 `--settings`、assertLaunchable 红时不调用 execFileImpl（stub 计数为 0）。
- [ ] **Step 2: 红 → Step 3: 实现 → Step 4: 绿**
- [ ] **Step 5: 变异纪律**：error.stdout 回捞分支去掉 → 对应测试红；assertLaunchable 前置去掉 → 「红时不 launch」测试红；恢复。
- [ ] **Step 6: Commit** `feat(launch): claude 执行流程——launch/resume 共用 attempt 闸 + assertLaunchable 前置 + 21-key 归一化`

---

### Task 10: launch.mjs — Codex 执行流程（launch：auth-copy + daemon + 首轮 + 轮询六态）

**Files:**
- Modify: `goal-condition-template/scripts/launch.mjs`
- Test: `goal-condition-template/tests/launch.test.mjs`

**Interfaces:**
- Produces: `runCodexLaunch({contract, stateDir, prompt, clientFactory?, authSource?, deadlineMs?, pollIntervalMs?}) → {outcome:'candidate'|'terminal_report', candidate?, status?, reasons?, threadId?}`；CLI `launch` 在 `contract.runtime==='codex'` 时走此路径。常量 `POLL_INTERVAL_MS=5000`、`WALL_CLOCK_DEADLINE_MS=1800000`（参数可覆盖仅供测试与 contract.budget.max_minutes 映射）。
- Consumes: Task 4/5/6 的 codex adapter 全部导出。

流程：
1. `nextAttempt`；probes → codex 侧 `assertLaunchable` 检查项（本 task 一并实现在 codex.mjs 补上 `assertLaunchable(contract, probes)`：confirmedHash/baselineDigestStored 通用项 + `codexVersionRaw` 已采集 + `sandboxMode==='workspace-write'` 与 contract physical 约束的 mechanism 声明逐条比对——mechanism 文本含 `sandbox` 而模式对不上 → 红；`residualLease===false`——state 目录无未过期 `lease.json`）。
2. **auth-copy**（§5 安全模式逐条落实）：
   - `codexHome = mkdtempSync(join(tmpdir(), 'gc-codex-home-'))`（与任何 work 目录独立、不共父）；路径写 `codex-home.path`（resume 复用）。
   - 只读复制 `authSource`（默认 `join(homedir(), '.codex', 'auth.json')`）→ `join(codexHome, 'auth.json')`，chmod 0600；**不碰** goals sqlite/config。
   - `cleanup()` 幂等：`rmSync(join(codexHome,'auth.json'), {force:true})` + `client.stop()` + 删 `lease.json`；注册 `process.on('SIGTERM', cleanup)`、`process.on('SIGINT', cleanup)`，主流程 `finally` 同调。**只删 auth 副本不删 codexHome**（thread/goal 状态要跨 attempt 存活；整目录清理在 `close` 子命令，Task 11）。
   - 写 `lease.json = {pid: process.pid, startedAt, heartbeatAt}`；轮询循环每拍刷新 heartbeatAt。stdio 直连本身把 daemon 生命周期绑在本进程上（进程死管道断），lease 文件供 assertLaunchable 残留检查与外部观测。
3. `clientFactory({codexHome, cwd: contract.target_roots[0], onEnvelope})` → `start` → `initialize` → `threadStart({sandbox:'workspace-write'})`（ephemeral:false 由 client 钉死）→ threadId 写 `thread.json`。
4. `goalSet({threadId, objective: prompt, ...(contract.budget?.user_provided && contract.budget.max_tokens ? {tokenBudget: contract.budget.max_tokens} : {})})` → ledger append（sequence 1）→ `assertSetReturnedStatus(env,'active')`，不过 → 终局。
5. `turnStart({threadId, text: prompt 附「工作至 goal complete」收口句})`（goal set 本身不驱动执行）。
6. 循环直到出结论：每 `pollIntervalMs` 一次 `goalGet` + 刷新 lease；同时订阅通知只**记录** `turn/started`/`turn/completed` 计数进 state（呈现用，不做判定）。每拍 `normalizeTerminal(goal)`：`poll` → 继续；`candidate` → 写 `candidate.json` 返回；`terminal_report` → 写终局报告返回（六态表语义：paused/usageLimited/budgetLimited/blocked 都停机不自动 resume）；`reject` → 终局。超 `deadlineMs`（contract.budget.max_minutes 存在时取 `min`）→ 终局报告。
7. onEnvelope → `rpc-envelopes.jsonl` 逐行 append（request/response 全留痕）。
8. **daemon 中途死**（client 管道错误/进程退出事件）→ abort 终局报告，报告体里显式写「执行器可能已改仓，须跑 snapshot verify 才能断言 mutation 状态」——abort 不得被读成无改动（§6）。

- [ ] **Step 1: 写失败测试**（fake clientFactory：脚本化响应序列驱动各路径）
  - happy path：set 返回 active → 若干拍 poll（fixture goal active）→ complete → candidate 落盘、ledger sequence=1、lease 清理、auth 副本被删（用临时 authSource fixture 文件 `{"OPENAI_FAKE":"placeholder"}`——**绝不用真实凭证**；断言 launch 结束后 codexHome 里 auth.json 不存在而 codexHome 目录仍在）。
  - set 被拒 path：goalSet 返回 `budgetLimited`（S2b 形状）→ 终局报告、不落 candidate、不发 turnStart（fake client 记录调用序列断言）。
  - 六态 path：poll 到 `paused` / `usageLimited` → 终局报告 `autoResume:false` 语义（不再发任何 goal.set）。
  - deadline path：`deadlineMs: 50` + 恒 active fixture → 终局报告 reasons 含 deadline。
  - envelope 留痕：`rpc-envelopes.jsonl` 行数 = fake client 请求+响应总数。
- [ ] **Step 2: 红 → Step 3: 实现 → Step 4: 绿**（真实 `codex`/真实 `~/.codex` 在单测中零接触：clientFactory 与 authSource 全注入）
- [ ] **Step 5: 变异纪律**：`assertSetReturnedStatus` 前置去掉 → set 被拒测试红；cleanup 里 auth 删除去掉 → auth 残留测试红；恢复。
- [ ] **Step 6: Commit** `feat(launch): codex launch 流程——auth-copy 信号安全 + 首轮 turn/start + 六态轮询 + envelope 留痕`

---

### Task 11: launch.mjs — Codex resume / finalize / close

**Files:**
- Modify: `goal-condition-template/scripts/launch.mjs`
- Test: `goal-condition-template/tests/launch.test.mjs`

**Interfaces:**
- Produces:
  - `runCodexResume({contract, stateDir, diagnosticText, raiseTokenBudget?, clientFactory?, authSource?, ...}) → 同 runCodexLaunch 返回形`；CLI `resume` codex 分支（`--raise-token-budget N` 仅显式传入才抬——抬升值须经用户确认，CLI flag 即确认载体，文档钉死）。
  - `runCodexFinalize({stateDir, binding, clientFactory?, authSource?}) → {receiptPath, readbackPath, attribution}`；CLI `finalize --state D --binding-file B`。
  - `runCodexClose({stateDir, clientFactory?}) → void`；CLI `close`：goal 若仍 active 先 `goalClear`（残留清理），随后整目录删除 codexHome、删 `codex-home.path`。
- Consumes: Task 5 的 `resumeRpcOps/verifyFinalizeAttribution`、Task 10 的 auth-copy/cleanup 骨架（抽成共用内部函数 `withCodexClient(stateDir, authSource, clientFactory, fn)`：负责 codexHome 复用（读 `codex-home.path`）、auth 复制/清理、lease、client 生命周期）。

resume 流程：`nextAttempt` → probes/assertLaunchable → `withCodexClient`：`threadResume({threadId})`（thread.json 读回；参数形状按 Task 5 Step 0 的 schema 核对结果）→ 按 `resumeRpcOps({threadId, diagnosticText, tokenBudget: raiseTokenBudget})` 逐 op 执行：goal.set 后 `assertSetReturnedStatus`（返回 `budgetLimited` 且未传 raise → 终局报告，提示需用户确认抬预算）→ inject → turn/start → 进入与 Task 10 相同的轮询循环（循环体抽共用函数）。ledger sequence 续接 +1。

finalize 流程（控制器 postflight 全绿、`nextAction` 返回 `finalize_runtime` 后才被调用——顺序由主会话把关，CLI 不自证）：`withCodexClient` → ledger 分配下一 sequence → `goalSet({threadId, status:'complete'})` → `goalGet` readback → `verifyFinalizeAttribution({setEnvelope, readbackEnvelope, threadId, sequence, ledger})`；ok → 写两个 controller-owned 证据文件：

```js
// finalization-receipt.json
{ ok: true, operation: 'thread/goal/set', status: 'complete', reasons: [], binding }
// runtime-readback.json
{ ok: true, source: 'thread/goal/get', status: 'complete', remaining_work: false,
  error: false, blocked: false, reasons: [], binding }
```

attribution 不过 → 两文件都写 `ok:false` + 安全 reasons（fail-closed；主会话喂 `nextAction` 自然被拒）。binding 从 `--binding-file`（主会话持有的 runBinding JSON）读入原样嵌入。

- [ ] **Step 1: 写失败测试**：resume 的 op 序列（fake client 记录：thread/resume → thread/goal/set → thread/inject_items → turn/start 顺序精确）；budgetLimited 未 raise → 终局且**不** inject/turnStart；raise 传入 → set params 带 tokenBudget；finalize happy path 两证据文件形状逐字段断言 + ledger sequence 校验；attribution broken（fake readback threadId 不同）→ 两文件 ok:false；close 后 codexHome 目录不存在。
- [ ] **Step 2: 红 → Step 3: 实现 → Step 4: 绿**
- [ ] **Step 5: 变异纪律**：finalize 里 `verifyFinalizeAttribution` 结果忽略（恒写 ok:true）→ attribution 测试红；resume 的 turn/start 省略 → 序列测试红；恢复。
- [ ] **Step 6: Commit** `feat(launch): codex resume/finalize/close——序列续接 + 三重归因出证据 + 残留清理`

---

### Task 12: `references/adapters/claude.md` 重写 + static 术语闸同步

**Files:**
- Rewrite: `goal-condition-template/references/adapters/claude.md`
- Modify: `goal-condition-template/tests/static.test.mjs`（`Claude adapter is runtime-specific and fail closed` 测试）

**内容依据**：spec v2 §4/§5 的 Claude 分支 + §2 调研事实（实现者先读 spec 这三节再动笔；spec 路径见计划头部）。重写后文档必须覆盖（每条都是硬性内容要求）：

1. 姿态声明：弃用 `/goal` 包装（保留记名并写明弃用理由：Haiku 弱判官、4000 字符上限、`disableAllHooks` 即失效）；改为裸 `claude -p` + controller 生成的 command 型 Stop hook。
2. Stop hook 契约：生成来源（contract postflight command entries 投影）、达标语义（逐条跑、多红收集不抛、红=非零退出——postflight 红判据在此钉死）、block 协议 = stdout JSON decision `{"decision":"block","reason":...}` + exit 0（非 exit 2）、reason 措辞与 objective 兼容（S3 死循环风险写明）、`MAX_HOOK_BLOCKS`/时间预算放行语义、hook 运行留痕与「运行次数 ≥ attempt 轮数」postflight 校验、**定位声明**（hook 是续轮驱动器不是验收，结论不进 controller 证据通道）。
3. hook 保护定性（v2 实测 S5 原文口径）：settings 对 hook 路径与 state 目录设 Edit deny；deny 对简单 Bash 重定向也有效（permission_denials 实录）、比四源审核 KR3 假设的强；精确上限（语义级 vs 字面）INCONCLUSIVE 待补测，不宣称完全物理保证。deny 路径必须 realpath 规范形。
4. 版本闸：`terminal_reason:"completed"` 是 2.1.223 实测锚定；SDK 文档取值集与实现漂移的警告；版本 allowlist 语义（新版本须重跑 S3/S5 才可加入）。
5. 终态：21-key 全集校验 fail-closed + 4 字段投影（沿用现文档的成功/失败 fixture 表格与 JSON 示例，投影语义补上）。
6. resume：`--resume <session_id>` 必带同一 `--settings`（不带则 hook 静默失效，S3 实测）；外环 `MAX_AUTO_RESUMES=2`；红项分类（未达标类可续 / 边界违规类立即终局）。
7. 保留现有 Launch 前置条件（runBinding/preflightEvidence JSON 块）、Postflight 与 Close 节的 controller-owned 证据语义——这些协议不变，只换启动姿态相关段落。
8. hook 命令副作用告诫（§10 advisory）：hook 命令集限无写副作用子集，或把产物路径纳入 `allowed_mutations` 并在 preview 显式列出。
9. 术语闸兼容：现测试 12 术语（`/goal`、`--disallowedTools`、`--settings`、`subtype`、`is_error`、`terminal_reason`、`permission_denials`、`baseline_digest`、`runBinding`、`preflightEvidence`、`postflightEvidence`、`controller-owned`）全部继续出现（`--disallowedTools` 保留为权限注入表面之一的记名）；`doesNotMatch(create_goal|get_goal|update_goal)` 维持。
10. 禁绝对私有路径（`/Users/`、`/home/` 触发 static 私有数据闸）——路径示例一律用 `~/.local/state/...` 或占位符。

- [ ] **Step 1: 扩术语闸（先红）**：static.test.mjs 的 Claude adapter 测试 term 数组追加：`'Stop hook'`、`'JSON decision'`、`'4000'`、`'disableAllHooks'`、`'--resume'`、`'21'`、`'2.1.223'`、`'realpath'`。跑测试确认对旧文档变红。
- [ ] **Step 2: 重写文档**（覆盖上列 10 条；结构沿用现文档章节序：前置条件 → 启动姿态与 hook → Runtime 终态 → resume 外环 → Postflight 与 Close）。
- [ ] **Step 3: `npm test` 全绿**（含链接解析、私有数据闸）。
- [ ] **Step 4: Commit** `docs(adapter): claude.md 重写为 Stop hook 姿态 + 术语闸同步`

---

### Task 13: `references/adapters/codex.md` 重写 + static 术语闸同步

**Files:**
- Rewrite: `goal-condition-template/references/adapters/codex.md`
- Modify: `goal-condition-template/tests/static.test.mjs`（`Codex adapter is runtime-specific...` 测试）

**内容依据**：spec v2 §2/§3 D3·D5/§4/§5 的 Codex 分支。硬性内容要求：

1. 姿态声明：外部编排唯一表面 = app-server JSON-RPC（`thread/goal/set|get|clear` + 通知）；`create_goal`/`get_goal`/`update_goal` 是线程内模型侧 tool、外部编排**没有调用通道**；objective 文本明令禁止模型 `create_goal`；「执行器自 finalize」列为反例。
2. 生命周期：stdio 直连 daemon（controller 持有生命周期、lease）、`thread/start ephemeral:false`（-32600 事实）、goal 由控制器 `thread/goal/set` 创建、`turn/start` 起首轮（goal set 不驱动执行）、续轮=目标未达成即自动链式（~13ms，非 idle 阈值）、订阅 `turn/started`/`turn/completed`。
3. 条件 CASE 写入语义 + 「读 set 返回的实际 status、不假定请求即生效」（S2b/S1b 联合证据口径）；六态处置表原样收录（含 paused/usageLimited 不自动 resume 的铁律理由、budgetLimited 抬预算须用户确认、预算下限以单轮最低开销 ~8000 tokens 为基准）。
4. resume：`thread/resume` + `resumeRpcOps` 顺序（set active → 读 set status → `thread/inject_items`（下划线、message item 形状）→ 显式 `turn/start`）；inject 不独立驱动执行的实测限制写明。
5. finalize 归因：goal_id RPC 层不可得；`threadId`+`updatedAt`+控制器单调序列号三重归因；receipt/readback 的 `operation:'thread/goal/set'`/`source:'thread/goal/get'` JSON 示例（把现文档两个 JSON 块的 operation/source 值换掉，其余字段不动）。
6. 信任边界：goalRpc controller 独占；S6 定级（seatbelt syscall 层拦 connect → finalize receipt 可信）+ caveat（替代进程证据、未在真实 daemon sock 交叉验证）原文口径。
7. auth-copy 安全模式四条（只读复制 auth、独立 mkdtemp、信号安全清理、凭证不进 git/fixture/日志）。
8. 附录：exec 单发回退路径记录（`--output-schema`/`--sandbox`/`exec resume`）+ 状态机降级开关**为未来预留、本轮未实现**的声明；`remaining_work`/`ready_for_postflight` 是本协议自造归一化层的声明维持。
9. 保留现有 blocked 阈值段（连续 ≥3 goal turn）与 controller-owned 四通道语义段。
10. 术语闸：现测试 18 术语全部继续出现（`create_goal`/`get_goal`/`update_goal` 以「模型侧 tool、外部无通道/禁用」的记名存在；`token_budget` 在 sqlite 记账语境保留一次）；`doesNotMatch(claude -p)` 维持。
11. 禁私有路径（同 Task 12 条 10）。

- [ ] **Step 1: 扩术语闸（先红）**：Codex adapter 测试 term 数组追加：`'thread/goal/set'`、`'thread/goal/get'`、`'thread/goal/clear'`、`'turn/start'`、`'thread/inject_items'`、`'ephemeral'`、`'tokenBudget'`、`'updatedAt'`、`'budgetLimited'`、`'usageLimited'`、`'auth-copy'`、`'app-server'`。
- [ ] **Step 2: 重写文档**；**Step 3: `npm test` 全绿**；
- [ ] **Step 4: Commit** `docs(adapter): codex.md 重写为 app-server 编排姿态 + 术语闸同步`

---

### Task 14: SKILL.md + run-contract.md 通道名改绑

**Files:**
- Modify: `goal-condition-template/SKILL.md:75`
- Modify: `goal-condition-template/references/run-contract.md:92`

- [ ] **Step 1: SKILL.md Postflight 节**（:75 一句话内两处替换，其余不动）：

`update_goal` receipt → `thread/goal/set` receipt；原始 `get_goal` readback → 原始 `thread/goal/get` readback。

- [ ] **Step 2: SKILL.md Launch 节**（:71）措辞校准：「本测试与文档流程本身不调用真实 runtime 工具」改为「协议文档与测试本身不调用真实 runtime 工具；真实启动由 `scripts/launch.mjs` 作为唯一执行豁口承担」。
- [ ] **Step 3: run-contract.md:92**：「也不得让 runtime 伪造 verifier 结果、`update_goal` receipt 或 `get_goal` envelope」→「…伪造 verifier 结果、`thread/goal/set` receipt 或 `thread/goal/get` envelope」。
- [ ] **Step 4: `npm test` 全绿**（static 闸会验 SKILL.md 行数与工作流字串未破坏）。**Step 5: 安装实例同步提醒**：本仓是源头，`~/.claude/skills/goal-condition/` 安装实例要等 release 重发布才更新——不手改安装实例。
- [ ] **Step 6: Commit** `docs(protocol): SKILL.md/run-contract.md finalize 通道名改绑 app-server RPC`

---

### Task 15: manifest / 安装闭包四处同步

**Files:**
- Modify: `goal-condition-template/scripts/lib/installer.mjs:19-32`
- Modify: `goal-condition-template/tests/install.test.mjs`（createSourceRepository fixture）
- Modify: `README.md`（release member 列表）
- Modify: `goal-condition-template/tests/static.test.mjs:127-135`（README 守护列表）

- [ ] **Step 1: 先改两个测试（红）**：
  - static.test.mjs `public docs expose...` 的 required member 数组追加三项：`'scripts/launch.mjs'`、`'scripts/lib/adapters/claude.mjs'`、`'scripts/lib/adapters/codex.mjs'`。
  - install.test.mjs `createSourceRepository` 追加三行（写在 `scripts/lib/workflow.mjs` 行后）：

```js
  await writeSourceFile(repo, 'scripts/launch.mjs', 'export const launchCli = true;\n');
  await writeSourceFile(repo, 'scripts/lib/adapters/claude.mjs', 'export const claudeAdapter = true;\n');
  await writeSourceFile(repo, 'scripts/lib/adapters/codex.mjs', 'export const codexAdapter = true;\n');
```

  注意 `incompleteCommit`（只含 SKILL.md 的首个 commit）语义不变——它本来就该因缺核心文件被拒。检查是否有对 `source_files` 数量 12 的硬断言（grep `12`），有则改 15。
- [ ] **Step 2: 生产改动**：installer.mjs `REQUIRED_CORE_FILES` 追加同三项（数组任意位置，校验是集合相等）；README release member 列表段追加同三项。目录闭包无需处理（`writeRelease` 逐段 mkdir 自动建 `scripts/lib/adapters/`——§7 已确认）。
- [ ] **Step 3: `npm test` 全绿**。
- [ ] **Step 4: Commit** `feat(installer): 公开闭包纳入 launch.mjs 与两个 runtime adapter（REQUIRED_CORE_FILES 15 项）`

⚠️ **发布顺序挂账（不在本 task 执行）**：REQUIRED_CORE_FILES 变更后，所有旧 release 的 `verify` 会因 `MANIFEST_CORE_SET_MISMATCH` 变红——**F6 信任链 re-pin 必须先于任何含新文件的 release**（spec §7/§10）。本计划只改源头仓，不发 release、不动安装实例。

---

### Task 16: 收尾——全量绿 + fault injection 五类覆盖核对 + 变异纪律汇总

**Files:**
- Test only（无生产改动；若核对发现缺口，补测试）

- [ ] **Step 1: `npm test` 全量绿**，记录最终测试数（基线 119 + 新增）。
- [ ] **Step 2: fault injection 五类逐条指认**（spec §7 tests 行；每类写出「哪个测试文件哪个用例」，缺一补一）：
  1. 伪造 receipt（错 operation 字面量）→ workflow.test.mjs 的 `operation:'update_goal'`/`operation:'runtimeResult'` 拒绝用例（Task 7）。
  2. cross-binding → workflow.test.mjs 既有 `every controller-owned channel...` 用例（未动，确认仍绿）。
  3. hook 篡改探针（必含 Bash 直接重定向用例）→ adapters-claude.test.mjs 的 hook sha256 不匹配 + deny 缺失用例（Task 3）；**再补一条**：从 `spikes/goal-runtime-adapters-v2/fixtures/s5-deny-surface.json` 取真实的 Bash 重定向 `permission_denials` 条目形状，构造 21-key result（`permission_denials` 非空）断言 `normalizeTerminal` ok 但 `runtimeTerminalState('claude', candidate)` 拒绝——Bash 旁路被拒的实测形状进入 pipeline 测试。
  4. attempt 超限 → launch.test.mjs 的 `nextAttempt` 超限用例（Task 8）。
  5. readback 不等于目标态 → adapters-codex.test.mjs 的 attribution broken 用例（Task 5）+ launch.test.mjs 的 set 被拒用例（Task 10）。
- [ ] **Step 3: 变异纪律汇总**：把 Task 1-15 各自 report 里的变异记录汇成一张表（判定点 → 变异动作 → 变红测试）附在本 task report；发现某判定无对应红 → 补测试。
- [ ] **Step 4: 终验 git 状态**：`git status` 干净、`git log --oneline` 逐 commit 可读；确认无任何凭证/私有路径进 git（`git grep -iE 'auth\.json 内容|bearer|sk-' -- ':!docs'` 抽查 + fixture 复核）。
- [ ] **Step 5: Commit**（如有补测试）`test(adapter): fault injection 五类覆盖收口`

---

## 执行期挂账（实现完成后、release 前）

1. **F6 信任链 re-pin**（§10）：先 re-pin 再发含新文件的 release；随后 `install.mjs` 重发布安装实例并外存新 manifestDigest。
2. S5 runC/runD 补测（KR3 精确机制语义级 vs 字面）：API 稳定期复用已 commit 的 spike 脚本重跑，结论折回 claude.md 措辞。
3. 真实 E2E 冒烟（可选、需用户授权 token 消耗）：最小 contract 各跑一次 claude/codex 全链路。

## Self-Review（写完计划后的自查记录）

- 覆盖核对（spec §7 改动清单逐行 → task）：adapters/claude.md→T12；adapters/codex.md→T13；SKILL.md→T14；run-contract.md→T14；workflow.mjs→T7；workflow.test.mjs→T7；launch.mjs+adapters→T1-T11;controller state 目录→T8（规格在 File Structure 段）；manifest/安装闭包→T15；tests fault injection 五类→T16 指认（分散在 T3/T5/T7/T8/T10）。降级开关按「范围决策」排除（已呈用户）。
- 类型/签名一致性：`normalizeTerminal`（claude 返回 `{ok,candidate,reasons}`、codex 返回 `{kind,...}`——两 runtime 形状不对称是设计明示，launch.mjs 分支消费）；`probes` 形状 T3 定义、T8 生产、T9 消费一致；ledger 形状 T5 定义、T10/T11 写入一致。
- 占位符扫描：无 TBD/TODO；文档任务给的是硬性内容清单 + spec 节指针（文档正文由 spec v2 承载，不在计划里复制两份）。



