# Goal-condition 跨运行时核心 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将公开 `goal-condition-template/` 重构为 Claude Code 与 Codex 共用的、可校验、可哈希确认、可在启动前后做边界快照的唯一核心协议。

**Architecture:** 用 JSON run contract 作为平台无关中间表示；`SKILL.md` 只负责编译、预览与路由，Claude/Codex 细节各自进入 adapter；Node 标准库脚本负责契约校验、状态机、快照和从指定 Git commit 物化安装。公开仓只包含脱敏核心，私有项目 profile 由 installer 注入。

**Tech Stack:** Node.js 20+（ESM、`node:test`、标准库）｜Git 2.x｜Markdown｜JSON Schema（仓内声明 + 针对该 schema 的 closed-world validator）

**Approved spec:** `docs/superpowers/specs/2026-08-05-goal-condition-cross-runtime-design.md`

**Command convention:** 除非命令块明确改变目录，本计划所有命令都从当前 `boundary-design` repository root 执行；公开文档不得固化某台机器的 checkout 路径。

## Global Constraints

- 本计划只修改公开 `boundary-design` 仓；不得写入组织名、私有绝对路径、凭据名、内部 dataset/asset ID。
- 不调用真实 Claude `/goal`、Codex `create_goal`，不写剪贴板，不访问外部 API。
- `goal-condition-template/SKILL.md` 必须不超过 200 行；frontmatter `description` 只描述触发条件，不摘要流程。
- `success_criteria.command` 只作为人类可读的精确命令展示，核心库不得对它使用 `eval`、`sh -c` 或 shell 字符串拼接。机器执行只接受 `cwd + argv[]`。
- 所有 Git/进程调用使用 `execFile` 或 `spawn` 的 argv 数组；特殊字符不得经过 shell quoting。
- contract、snapshot、installer 任一前置条件不成立时 fail closed；错误必须包含字段/entry ID、observed、expected、next step。
- 每个 Task 严格 RED → 最小实现 → GREEN → commit；不把红测试提交给下一 Task。
- 只提交到 `codex/goal-condition-cross-runtime`，不 push、不发布、不合并。

## 设计决策摘要

根因是自然语言 skill 同时承担 compiler、launcher、verifier，却没有机器可校验的中间产物；未版本化生效副本又与公开模板并存，导致平台耦合、手工同步、旧测试背书新协议和静态内容污染。

最小改动方案是压缩现有 skill、删除污染文本、修 README 并人工写一份 Codex objective。它可作为紧急 fallback，但无法证明启动前边界、无法防副本漂移，也无法提供跨运行时一致的完成语义。

本计划采用彻底方案：结构化 run contract + 状态机 + preflight/postflight + commit-pinned installer。代价是新增约 5 个库/CLI 模块和一套测试；收益是把易漂移的文字约定变成可复验接口，并让 Claude/Codex 共用同一核心哈希。

> **2026-08-05 final-review hardening：** 下列接口片段已按最终安全评审收紧：context 使用 `{id,path,sha256}` content binding；snapshot v2 由外部 `baselineDigest` 绑定完整 context/mode/Git index/refs；两个 runtime 都使用 controller-owned preflight/postflight evidence；release 验证必须接收外部 `manifestDigest`。未改动的 checkbox 与 RED/GREEN 叙述仍是原实施历史。

## File Structure

| 文件 | 责任 |
|---|---|
| `package.json` | 零依赖测试入口与 Node 版本约束 |
| `goal-condition-template/schema/run-contract.schema.json` | run contract 的公开 closed-world 形状 |
| `goal-condition-template/scripts/lib/contract.mjs` | 读取、校验、canonical JSON、hash、preview |
| `goal-condition-template/scripts/lib/workflow.mjs` | 确认/preflight/runtime/postflight 的 fail-closed 状态机 |
| `goal-condition-template/scripts/lib/snapshot.mjs` | Git、路径、结构化命令的快照与差异判定 |
| `goal-condition-template/scripts/lib/installer.mjs` | 从指定 Git commit 读取核心、生成 manifest、原子切换链接 |
| `goal-condition-template/scripts/*.mjs` | validator、snapshot、installer 的薄 CLI |
| `goal-condition-template/references/run-contract.md` | 字段语义与编译规则 |
| `goal-condition-template/references/adapters/*.md` | Claude/Codex 的启动与完成语义 |
| `goal-condition-template/tests/*.test.mjs` | contract、workflow、snapshot、install、文档静态门禁 |
| `goal-condition-template/tests/fixtures/*.json` | 合法/非法 contract 与压力场景 |

---

## Task 1: 建立 run contract schema、validator、稳定渲染与 hash

**Files:**

- Create: `package.json`
- Create: `goal-condition-template/schema/run-contract.schema.json`
- Create: `goal-condition-template/scripts/lib/contract.mjs`
- Create: `goal-condition-template/scripts/validate-contract.mjs`
- Create: `goal-condition-template/tests/contract.test.mjs`
- Create: `goal-condition-template/tests/fixtures/valid-contract.json`

**Interfaces:**

```js
export async function readContract(filePath) // Promise<object>
export function validateContract(value)     // Array<Diagnostic>
export function canonicalJson(value)        // stable key order + trailing newline
export function contractHash(value)         // lowercase SHA-256 hex
export function renderPreview(value)        // full objective + matrices + hash
```

`Diagnostic` 的固定形状：

```js
{
  code: 'CONSTRAINT_MECHANISM_REQUIRED',
  path: 'constraints[0].mechanism',
  observed: '',
  expected: 'non-empty string when enforcement=physical',
  next: 'supply an executable mechanism or mark the constraint audit_only'
}
```

- [ ] **Step 1: 先写 contract fixture 与失败测试**

`valid-contract.json` 使用 `/opt/goal-condition-example/` 下的通用绝对示例路径：`runtime="codex"`、一个 objective、一个 judgment criterion、一个 success criterion、一个 `audit_only` constraint、一个 Git preflight 和一个 command postflight。不要写任何真实组织或项目名，也不要把 `/tmp` 当成稳定 context。

`contract.test.mjs` 至少包含这些断言：

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  validateContract, canonicalJson, contractHash, renderPreview,
} from '../scripts/lib/contract.mjs';

const fixtureUrl = new URL('./fixtures/valid-contract.json', import.meta.url);
const valid = JSON.parse(await readFile(fixtureUrl, 'utf8'));

test('valid contract has no diagnostics', () => {
  assert.deepEqual(validateContract(valid), []);
});

test('objective is one string and unknown fields fail closed', () => {
  assert.ok(validateContract({ ...valid, objective: ['goal-a', 'goal-b'] })
    .some((x) => x.path === 'objective'));
  assert.ok(validateContract({ ...valid, surprise: true })
    .some((x) => x.code === 'UNKNOWN_FIELD'));
});

test('physical constraints require mechanism and verifier', () => {
  const broken = structuredClone(valid);
  broken.constraints[0] = {
    id: 'C1', rule: 'Do not mutate the protected asset', enforcement: 'physical',
    mechanism: '', verify: '',
  };
  assert.deepEqual(
    validateContract(broken).map((x) => x.path),
    ['constraints[0].mechanism', 'constraints[0].verify'],
  );
});

test('budget is accepted only when its provenance is explicit', () => {
  assert.ok(validateContract({ ...valid, budget: { max_tokens: 9000 } })
    .some((x) => x.path === 'budget.user_provided'));
  assert.deepEqual(validateContract({
    ...valid, budget: { user_provided: true, max_tokens: 9000 },
  }), []);
});

test('temporary context and duplicate IDs fail closed', () => {
  const temporary = structuredClone(valid);
  temporary.context_sources[0].path = '/private/tmp/context.md';
  assert.ok(validateContract(temporary).some((x) => x.code === 'TEMP_CONTEXT'));
  const duplicate = structuredClone(valid);
  duplicate.judgment_criteria.push({ ...duplicate.judgment_criteria[0] });
  assert.ok(validateContract(duplicate).some((x) => x.code === 'DUPLICATE_ID'));
});

test('machine commands require argv and reject shell fields', () => {
  const broken = structuredClone(valid);
  broken.postflight[0] = {
    id: 'V1', type: 'command', cwd: '/tmp/worktree', shell: 'npm test',
  };
  assert.ok(validateContract(broken).some((x) => x.path === 'postflight[0].argv'));
  assert.ok(validateContract(broken).some((x) => x.code === 'UNKNOWN_FIELD'));
});

test('canonical preview preserves punctuation without shell interpolation', () => {
  const dangerous = '$' + '3.69';
  const changed = { ...valid, objective: `中文 'single' "double" \\ ${dangerous}` };
  assert.equal(JSON.parse(canonicalJson(changed)).objective, changed.objective);
  assert.equal(contractHash(changed), contractHash(JSON.parse(canonicalJson(changed))));
  assert.match(renderPreview(changed), new RegExp(contractHash(changed)));
  assert.ok(renderPreview(changed).includes(changed.objective));
});
```

- [ ] **Step 2: 运行测试，确认 RED**

```bash
node --test goal-condition-template/tests/contract.test.mjs
```

Expected: FAIL，`ERR_MODULE_NOT_FOUND` 指向 `scripts/lib/contract.mjs`。

- [ ] **Step 3: 添加 package 与 schema**

`package.json` 必须是：

```json
{
  "private": true,
  "type": "module",
  "engines": {"node": ">=20"},
  "scripts": {
    "test": "node --test goal-condition-template/tests/*.test.mjs"
  }
}
```

schema 顶层使用 `additionalProperties: false`，并要求：

- `version` 恒为 `1`；`runtime` 只能是 `claude|codex`。
- `objective` 是非空字符串，不接受数组。
- `context_sources` 是 closed-world `{id,path,sha256}` 数组；ID 全局唯一，path 必须为规范绝对非临时路径，sha256 必须是文件 bytes 的小写 SHA-256。
- `target_roots`、`judgment_criteria`、`success_criteria`、`preflight`、`postflight` 至少一项。
- `constraints` 可为空；`enforcement` 只能是 `physical|audit_only`。
- `allowed_mutations` 固定为 `files|git|external` 三个字符串数组。
- `budget` 可选；存在时必须含 `user_provided: true`，并至少含 `max_turns|max_minutes|max_tokens|max_cost_usd` 之一。
- 机器命令项使用 `cwd` 与非空 `argv` 数组；可声明仅含变量名的 `requires_env`，执行前逐项检查但绝不把值写入 snapshot；禁止额外的 shell 字段。
- Git preflight 可声明 `require_branch`、`require_clean`、`require_upstream`；path preflight 可声明 `require: file|directory|exists`。

三种 entry 的 closed-world 形状固定为：

```js
// preflight only
{ id, type: 'git', target, require_branch?, require_clean?, require_upstream? }
{ id, type: 'path', target, require: 'file' | 'directory' | 'exists' }
// preflight or postflight
{ id, type: 'command', cwd, argv: string[], requires_env?: string[], capture?: 'hash' | 'text' }
```

`postflight` 不接受 `git|path` shorthand；边界 Git/path 的启动后复验统一由 baseline compare 完成，postflight 只列独立 success verifier。

- [ ] **Step 4: 实现 closed-world validator、canonical renderer 和 CLI**

`contract.mjs` 不声称实现通用 JSON Schema Draft validator。它只针对本仓 schema 做确定性检查，并在模块顶层导出固定字段表供测试对照。canonical 算法递归排序 object keys、保持 array 顺序，最后追加一个换行；hash 只对 canonical UTF-8 bytes 计算。

`validate-contract.mjs` 只接受这两个调用形状：

```bash
node goal-condition-template/scripts/validate-contract.mjs --contract FILE
node goal-condition-template/scripts/validate-contract.mjs --contract FILE --preview
```

无诊断时打印一行匹配 `^VALID contract sha256=[0-9a-f]{64}$`；有诊断时逐行打印 `code path observed=... expected=... next=...` 并 exit 1。不得执行 contract 中的任何命令。

- [ ] **Step 5: GREEN，并验证 CLI 不损坏特殊字符**

```bash
node --test goal-condition-template/tests/contract.test.mjs
node goal-condition-template/scripts/validate-contract.mjs \
  --contract goal-condition-template/tests/fixtures/valid-contract.json \
  --preview
```

Expected: contract tests 全绿；CLI exit 0，首行匹配 `^VALID contract sha256=[0-9a-f]{64}$`，preview 含完整 objective、判断标准、约束矩阵、验收标准和同一 hash。

- [ ] **Step 6: Commit**

```bash
git add package.json goal-condition-template/schema \
  goal-condition-template/scripts/lib/contract.mjs \
  goal-condition-template/scripts/validate-contract.mjs \
  goal-condition-template/tests/contract.test.mjs \
  goal-condition-template/tests/fixtures/valid-contract.json
git commit -m "feat: add goal run contract validator"
```

---

## Task 2: 固化确认闸与跨运行时 fail-closed 状态机

**Files:**

- Create: `goal-condition-template/scripts/lib/workflow.mjs`
- Create: `goal-condition-template/tests/workflow.test.mjs`
- Create: `goal-condition-template/tests/fixtures/pressure-cases.json`

**Interfaces:**

```js
export function nextAction({
  validation,
  contractHash,
  confirmedHash,
  runtime,
  runBinding,
  preflightEvidence,
  runtimeResult,
  postflightEvidence,
  finalizationReceipt,
  runtimeReadback,
}) // { action, reasons }

// action ∈ preview | preflight | launch | postflight | finalize_runtime | verify_runtime | complete | reject
export function runtimeTerminalState(runtime, result) // { ok, reasons }
```

- [ ] **Step 1: 写状态转换失败测试**

覆盖以下完整矩阵：

```js
const contractHash = 'a'.repeat(64);
const baselineDigest = 'b'.repeat(64);
const runBinding = { contractHash, baselineDigest, runId: 'run-1' };
const preflightEvidence = { ok: true, reasons: [], binding: runBinding };
assert.equal(nextAction({ validation: [], contractHash, confirmedHash: 'c'.repeat(64) }).action, 'preview');
assert.equal(nextAction({ validation: [], contractHash, confirmedHash: contractHash }).action, 'preflight');
assert.equal(nextAction({
  validation: [], contractHash, confirmedHash: contractHash,
  runtime: 'claude', runBinding, preflightEvidence,
}).action, 'launch');
```

并断言：

- validation 有错时 `reject`；内容变化后旧确认 hash 失效。
- “直接跑”“赶时间”等 pressure case 不改变状态机输入，仍停在 preview。
- Claude `subtype=success` 但 `is_error=true`、`terminal_reason=api_error` 或 `permission_denials` 非空均 `reject`。
- Codex 仍有 `remaining_work`、goal 非 terminal、或状态只是 `blocked` 均不得 complete。
- 两个 runtime 都必须先有与 confirmed hash/baseline digest/run ID 同 binding 的 controller-owned `preflightEvidence` 才能 launch。
- runtime 绿后必须先进入 `postflight`；同 binding 的 controller-owned `postflightEvidence` 缺失或有差异均不得 complete。
- Claude exact terminal result + bound postflight 可 complete；Codex 还必须按 `finalize_runtime` → `verify_runtime` 提供独立 `update_goal` receipt 与 `get_goal` readback。

`pressure-cases.json` 固定包含五类：催促绕过 preview、多目标未选择、无法物理限制外部动作、表面 success 但缺产物、compaction 后 context 只存在于临时路径。每条包含 `input`、`expected_action`、`forbidden_claims`。

- [ ] **Step 2: 运行测试，确认 RED**

```bash
node --test goal-condition-template/tests/workflow.test.mjs
```

Expected: FAIL，`ERR_MODULE_NOT_FOUND` 指向 `scripts/lib/workflow.mjs`。

- [ ] **Step 3: 实现纯状态机**

状态机不得调用 runtime 工具。实现顺序必须固定：

```js
if (validation.length) return reject(validation);
if (confirmedHash !== contractHash) return preview('confirmation hash mismatch');
if (!runBinding || !preflightEvidence) return action('preflight');
if (!bindingMatches(runBinding, preflightEvidence.binding) || !preflightEvidence.ok) return reject(...reasons);
if (!runtimeResult) return action('launch');
if (!runtimeTerminalState(runtime, runtimeResult).ok) return reject(...reasons);
if (!postflightEvidence) return action('postflight');
if (!bindingMatches(runBinding, postflightEvidence.binding) || !postflightEvidence.ok) return reject(...reasons);
if (runtime === 'claude') return action('complete');
if (!finalizationReceipt) return action('finalize_runtime');
if (!runtimeReadback) return action('verify_runtime');
return verifiedCodexCompletion(finalizationReceipt, runtimeReadback, runBinding);
```

Claude 与 Codex 的终态判据分别放在命名函数中，公共 `nextAction` 不猜平台字段。

- [ ] **Step 4: GREEN 并提交**

```bash
node --test goal-condition-template/tests/workflow.test.mjs
git add goal-condition-template/scripts/lib/workflow.mjs \
  goal-condition-template/tests/workflow.test.mjs \
  goal-condition-template/tests/fixtures/pressure-cases.json
git commit -m "feat: add fail-closed goal workflow state machine"
```

Expected: workflow tests 全绿；测试进程中没有 `claude`、`pbcopy`、`create_goal` 或网络调用。

---

## Task 3: 实现启动前 snapshot 与启动后边界对比

**Files:**

- Create: `goal-condition-template/scripts/lib/snapshot.mjs`
- Create: `goal-condition-template/scripts/snapshot.mjs`
- Create: `goal-condition-template/tests/snapshot.test.mjs`

**Interfaces:**

```js
export async function captureSnapshot(contract, options = {}) // Snapshot
export function compareSnapshot(contract, baseline, current, { expectedBaselineDigest })  // { ok, changes, violations }
```

CLI：

```bash
node goal-condition-template/scripts/snapshot.mjs capture \
  --contract CONTRACT --out BASELINE
node goal-condition-template/scripts/snapshot.mjs verify \
  --contract CONTRACT --baseline BASELINE \
  --expected-baseline-digest TRUSTED_DIGEST
```

- [ ] **Step 1: 在临时 Git 仓写失败测试**

测试用 `mkdtemp` 创建 repo，配置本地 test identity，提交 `tracked.txt`，再预置一个 dirty 文件。fixture contract 声明：

- target root 是临时 repo；branch 是 `codex/test-snapshot`。
- 允许修改 `tracked.txt`，不允许修改 `protected.txt`。
- Git 允许 `commit`，不允许 `push` 或切换到非声明分支。

断言：

- baseline schema v3 记录 content-bound contexts、file/directory modes、HEAD、branch、upstream（不存在时明确为 `null`）、porcelain、带 blob bytes hash 的 committed tree、独立 index entries、Git clean-filter 投影并递归展开的 effective material、完整 Git refs map，以及忽略 replace objects 且拒绝 graft/shallow history 的 exact baseline/current HEAD ancestry evidence。
- baseline 前已有 dirty state 在 current 中不算本次违规。
- baseline 后改允许文件只出现在 `changes`，改保护文件出现在 `violations`。
- 缺 upstream 不伪装成失败；若 contract 明确要求 upstream，则以 entry ID 失败。
- 非 Git root、多 root、结构化 command 非零退出都给完整 Diagnostic。
- 任一 preflight entry 失败时 CLI 不写出可用于 launch 的 baseline 文件。

- [ ] **Step 2: 运行测试，确认 RED**

```bash
node --test goal-condition-template/tests/snapshot.test.mjs
```

Expected: FAIL，`ERR_MODULE_NOT_FOUND` 指向 `scripts/lib/snapshot.mjs`。

- [ ] **Step 3: 实现安全采集与差异分类**

- Git 命令全部经 `execFile('git', ['-C', target, ...])`。
- `path` entry 对文件记录 bytes hash；对目录记录稳定排序的相对路径、类型、bytes hash，不跟随越界 symlink。
- `command` entry 只接受 schema 已验证的 `cwd + argv[]`；默认只保存 stdout/stderr hash，只有 contract 明确 `capture: "text"` 时保存文本。
- `command.requires_env` 有任何变量缺失即 preflight 失败；snapshot 只记录变量名与 `present=true`，不得记录 secret value。
- 文件允许模式只支持绝对精确路径和以 `/**` 结尾的目录前缀；出现其他 glob 元字符直接 validation error，避免自制不完整 glob 引擎。
- Snapshot 顶层必须含 `schema_version: 3`、`contract_hash`、`captured_at`、`contexts`、`entries`。编排器把 `baseline_digest` 保存在 baseline 文件之外；verify 缺少 `expectedBaselineDigest`、发现 contract/context/hash/mode/index/refs/ancestry/committed material 不一致时立即拒绝。

- [ ] **Step 4: GREEN、CLI smoke、提交**

```bash
node --test goal-condition-template/tests/snapshot.test.mjs
node goal-condition-template/scripts/snapshot.mjs --help
git add goal-condition-template/scripts/lib/snapshot.mjs \
  goal-condition-template/scripts/snapshot.mjs \
  goal-condition-template/tests/snapshot.test.mjs
git commit -m "feat: add preflight and postflight snapshots"
```

Expected: snapshot tests 全绿；`--help` exit 0，并只列 `capture|verify` 两个子命令。

---

## Task 4: 从指定 Git commit 物化安装并让两套 runtime 共用核心

**Files:**

- Create: `goal-condition-template/scripts/lib/installer.mjs`
- Create: `goal-condition-template/scripts/install.mjs`
- Create: `goal-condition-template/tests/install.test.mjs`

**Interfaces:**

```js
export async function installRelease({
  repo,
  ref,
  profile,
  releaseRoot,
  links,
  backupRoot,
}) // { commit, releaseDir, manifest, manifestDigest, backups }

export async function verifyRelease(releaseDir, { expectedManifestDigest }) // { ok, drift, manifestDigest }
```

- [ ] **Step 1: 写 installer 的失败测试**

临时 repo 必须至少生成两个 commit，让 worktree 内容与指定旧 commit 不同。测试断言 installer：

- 通过 `git rev-parse` 解析 ref，并用 `git ls-tree` + `git show` 读取指定 commit；不能复制当前 worktree。
- release 目录名使用完整 commit hash，manifest 记录 closed-world 完整 core 文件集的 SHA-256 与 Git mode；缺少任何必需文件都在 release/link/backup mutation 前失败。
- 私有 profile 写到安装包 `references/anchors-and-rules.md`，只记录独立 `profile_sha256`，不进入 public `source_files` 清单。
- Claude/Codex 两个 link 的 `realpath` 完全相同。
- 安装返回外部保留的 `manifestDigest`；手改 release core 并重算内部 manifest 后，`verifyRelease(releaseDir, {expectedManifestDigest})` 仍报 drift。
- link 位置已有普通目录时 fail closed；只有显式 `backupRoot` 才把它原样移动到可恢复备份，再原子建立 symlink。
- manifest 与安装文件中不包含 feature worktree 的绝对路径。

- [ ] **Step 2: 运行测试，确认 RED**

```bash
node --test goal-condition-template/tests/install.test.mjs
```

Expected: FAIL，`ERR_MODULE_NOT_FOUND` 指向 `scripts/lib/installer.mjs`。

- [ ] **Step 3: 实现 commit-pinned installer**

CLI 固定参数：

```text
install --repo PATH --ref REF --profile FILE --release-root PATH
        --link NAME=PATH [--link NAME=PATH ...] [--backup-root PATH]
verify  --release PATH --expected-manifest-digest DIGEST
```

安装 allowlist 只含 skill runtime 需要的文件：`SKILL.md`、`references/run-contract.md`、`references/adapters/*.md`、`schema/*.json`、`scripts/*.mjs`、`scripts/lib/*.mjs`。tests、README、设计文档不得进入 release。

切换 link 时先在同目录创建带 PID 的临时 symlink，再 `rename`；目标为普通文件/目录时先按显式 backup policy 处理，绝不静默覆盖。release 已存在时先 verify；相同则幂等返回，不同则拒绝覆盖不可变目录。

- [ ] **Step 4: GREEN、CLI smoke、提交**

```bash
node --test goal-condition-template/tests/install.test.mjs
node goal-condition-template/scripts/install.mjs --help
git add goal-condition-template/scripts/lib/installer.mjs \
  goal-condition-template/scripts/install.mjs \
  goal-condition-template/tests/install.test.mjs
git commit -m "feat: install goal-condition from pinned commits"
```

Expected: install tests 全绿；`--help` exit 0；测试只写 `mkdtemp` 下的目录。

---

## Task 5: 精简核心 skill，拆分 contract 与 runtime adapters

**Files:**

- Create: `goal-condition-template/tests/static.test.mjs`
- Modify: `goal-condition-template/SKILL.md`
- Create: `goal-condition-template/references/run-contract.md`
- Create: `goal-condition-template/references/adapters/claude.md`
- Create: `goal-condition-template/references/adapters/codex.md`
- Modify: `goal-condition-template/references/anchors-and-rules.md`
- Modify: `boundary-design/SKILL.md`

- [ ] **Step 1: 先把当前已知漂移固化成 RED 静态测试**

`static.test.mjs` 读取 Markdown，不执行 skill。固定断言：

- frontmatter `name` 精确为 `goal-condition`。
- `description` 精确为“当用户要求把任务、边界包或已有完成条件编译成可确认、可验证的 Claude Code 或 Codex goal 运行契约时使用。”
- `SKILL.md` 行数不超过 200，所有相对引用存在。
- 所有会被 loader 读取的 Markdown 都不匹配 dollar 后紧跟数字的模式；测试自身用字符串拼接构造模式样例。
- anchors template 不含“当前基线数字”或测试数占位符。
- Claude adapter 含 `/goal`、`--disallowedTools`、`--settings`、`subtype`、`is_error`、`terminal_reason`、`permission_denials`，且不含 Codex tool 名。
- Codex adapter 含 `create_goal`、`get_goal`、`update_goal`、`token_budget`、`audit_only`，且不含 `claude -p`。
- `boundary-design/SKILL.md` 输出平台无关 boundary package/run contract，不再把 downstream 写死为 Claude `/goal`。

- [ ] **Step 2: 运行测试，确认当前 RED**

```bash
node --test goal-condition-template/tests/static.test.mjs
```

Expected: 至少因 description 不符、缺 adapter/reference、anchors 矛盾和现存 dollar-number 文本而 FAIL。

- [ ] **Step 3: 重写核心 SKILL.md（≤200 行）**

正文只保留：输入分类、单 goal 选择、contract 编译、validator 调用、完整 preview + hash、明确确认、adapter 路由、独立 postflight、失败语义。CLI 帮助、平台字段表和项目锚点全部移出核心。

核心不可跳过的顺序必须原样出现：

```text
Classify → Compile → Validate → Preview → Confirm(hash)
→ Preflight → Launch(adapter) → Postflight → Close
```

明确写出：任何字节变化使确认失效；多目标先选一个；preflight 失败不 launch；执行会话不得自证；`audit_only` 不得称为物理拦截；本 skill 不递归创建另一个 goal。

- [ ] **Step 4: 写 run-contract reference 与两个 adapter**

`run-contract.md` 逐字段说明 schema、编译映射、预算 provenance、结构化 machine command 和 error diagnostic；引用 schema/validator，不复制完整 JSON Schema。

Claude adapter 规定：文件安全输入、任务级 deny/settings、`subtype + is_error + terminal_reason + permission_denials` 联合判定，以及成功/失败 fixture。Codex adapter 规定：确认后才 `create_goal`；仅明确用户预算才传 `token_budget`；模型/reasoning effort 是会话配置；用 `get_goal` 读状态；只有 postflight 全绿且无剩余工作才 `update_goal(complete)`；blocked 遵循 runtime 阈值。

`anchors-and-rules.md` 改为无私有数据的 profile 模板，只允许“核验命令/来源”，不得保存会过期的当前测试数或历史基线数字。

- [ ] **Step 5: 修 boundary-design 的下游合同**

保留四判断题与表达形式阶梯，但输出术语改为 run contract 可消费的：hard boundary → constraint、judgment standard → judgment criterion、acceptance artifact → success criterion、mechanization → physical/audit_only。不得复制 Claude launcher。

- [ ] **Step 6: GREEN 并提交**

```bash
node --test goal-condition-template/tests/static.test.mjs
test "$(wc -l < goal-condition-template/SKILL.md)" -le 200
git add boundary-design/SKILL.md goal-condition-template/SKILL.md \
  goal-condition-template/references goal-condition-template/tests/static.test.mjs
git commit -m "refactor: split goal contract from runtime adapters"
```

Expected: 静态测试全绿，line gate exit 0。

---

## Task 6: 更新 README、批准状态并跑公开发布前门禁

**Files:**

- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-08-05-goal-condition-cross-runtime-design.md`

- [ ] **Step 1: 写 README 当前漂移的 RED probes**

```bash
! rg -n '三步协议|cp -r goal-condition-template' README.md
! rg -n '状态：待用户书面审阅' \
  docs/superpowers/specs/2026-08-05-goal-condition-cross-runtime-design.md
```

Expected before edit: 两条命令均非零，因为当前 README 仍写“三步协议”与复制安装，spec 状态仍待审。

- [ ] **Step 2: 更新 README 与 spec 状态**

README 只讲当前架构：boundary-design 输出、run contract、hash 确认、两套 adapter、commit-pinned installer、私有 profile 注入、测试命令。删除 `cp -r` 安装方式。旧合成评测如保留，必须明确标注为历史三步版结果，不能证明当前跨运行时版本。

spec 状态改为：`状态：已批准（2026-08-05）`。不得改写已批准设计的其他语义。

- [ ] **Step 3: 跑全套门禁**

```bash
npm test
git diff --check
test "$(wc -l < goal-condition-template/SKILL.md)" -le 200
! rg -n '\$[0-9]' goal-condition-template --glob '*.md'
! rg -n '三步协议|cp -r goal-condition-template' README.md
! rg -n '/Users/|/home/|[A-Za-z_]*(SECRET|TOKEN|API_KEY)|sk-[A-Za-z0-9]' \
  README.md boundary-design goal-condition-template
node goal-condition-template/scripts/validate-contract.mjs \
  --contract goal-condition-template/tests/fixtures/valid-contract.json \
  --preview
git status --short
```

Expected: `npm test` 全绿；所有 negated `rg` exit 0；validator exit 0；`git status --short` 只列本 Task 的 README/spec 修改。

- [ ] **Step 4: Commit**

```bash
git add README.md docs/superpowers/specs/2026-08-05-goal-condition-cross-runtime-design.md
git commit -m "docs: publish cross-runtime goal-condition workflow"
```

- [ ] **Step 5: 提交后终验**

```bash
npm test
git diff --check HEAD^ HEAD
git status --short --branch
git log --oneline --decorate -7
```

Expected: tests 全绿；diff check 无输出；worktree clean；所有实现 commit 只在 `codex/goal-condition-cross-runtime`，没有 push/merge。

## Definition of Done

- 公共 contract 可稳定 canonicalize/hash，非法、多目标、臆造预算和伪 physical constraint 均 fail closed。
- 状态机不允许跳过 hash 确认、preflight 或 postflight；Claude/Codex 假成功均不能 complete。
- snapshot 能区分既存 dirty state 与本次边界差异，且不靠 shell 字符串。
- installer 从明确 commit 物化不可变 release，双 runtime 入口同源，已有目录只做显式可恢复迁移。
- 核心 skill ≤200 行，README/adapter/上游 boundary-design 语义一致，无旧三步文案和 dollar-number 污染。
- 公开扫描不含私有上下文；测试不会自动启动真实 goal。
