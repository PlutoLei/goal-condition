# goal-condition adapter v2 —— Spike 验证阶段实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用可复现的探测脚本实测 spec §8 的 7 个 spike，产出「每条 PASS/FAIL + 证据锚点 + 真实 envelope fixture」，为实现阶段确定 Codex（app-server 全量 vs 回退 exec）与 Claude（Stop hook vs 回退裸 -p）两条路径的最终形状。

**Architecture:** 每个 spike 是一个独立的 Node ESM 探测脚本，跑在**隔离沙盒**里（临时 `CODEX_HOME`、ephemeral thread、scratch 工作目录、合成 objective），绝不碰生产 `~/.codex` 或任何真实业务 goal。Codex 侧共用一个 app-server JSON-RPC 客户端 harness；Claude 侧共用一个 `-p` + settings + hook 探针 harness。每个 spike 把真实响应 envelope 落成 fixture，把判读结论追加进一份决策矩阵文档。

**Tech Stack:** Node.js ≥20（ESM `.mjs`，仅标准库：`node:child_process`/`node:net`/`node:fs`/`node:crypto`）；`codex app-server`（JSON-RPC over stdio 与 unix sock）；`claude -p --output-format json` + `--settings` hooks。

## Global Constraints

- **隔离铁律**：每个 Codex spike 必须设 `CODEX_HOME=<scratch>/codex-home-<spike>`（独立目录，隔离 `goals_*.sqlite`），且 `thread/start` 尽量传 `ephemeral:true`；工作目录用 scratch 子目录。绝不读写生产 `~/.codex/goals_1.sqlite`，绝不操作任何已存在的真实 goal。
- **合成 objective**：所有 goal 的 objective 用合成字符串（如 `"Write the exact text DONE-<n> into ./out.txt then stop."`），绝不抄取任何真实业务任务、健康数据或用户内容进 spike。
- **无覆盖开关**：spike 脚本自身不得使用 `--dangerously-bypass-approvals-and-sandbox`、`--dangerously-bypass-hook-trust` 等旁路；S6 需要执行器视角时用受控 `--sandbox workspace-write`，不用 danger 档。
- **spike 产物不进核心闭包**：spike 脚本落 `spikes/goal-runtime-adapters-v2/`，决策矩阵落 `docs/superpowers/spikes/`，fixture 落 spike 目录下 `fixtures/`——**均不加入** `installer.mjs` 的 `REQUIRED_CORE_FILES`（它们是一次性探测，不是核心协议）。实现阶段再挑选 fixture 复制进 `goal-condition-template/tests/fixtures/`。
- **提交分支**：只 commit 到当前分支 `codex/goal-condition-cross-runtime`，不 push、不合并、不建 PR。
- **仓根**：本仓 checkout 根目录（下称 `$REPO`）。
- **判读诚实**：spike 失败（机制不成立）是一等合格结局——它触发 spec §8 的回退路径。绝不为了「让 spike 绿」而放宽判定或改用旁路；FAIL 如实记进决策矩阵。
- **每个 spike 真实消耗 API/token**：这是验证的必要成本；用最小 objective 与紧 deadline 控制开销。
- **防跑飞（吸收自并行草稿）**：所有**创建** goal 的 `thread/goal/set`（带 objective 的那次）必须带 `tokenBudget: 50000`——goal 一旦 active 会自动续轮烧 token，无预算硬顶可能跑飞。唯一例外：S1b 的「同请求抬 tokenBudget」变体按其脚本用更大值。
- **goal 必须挂非 ephemeral thread（S1a 实测）**：ephemeral thread 会拒 goal RPC（`-32600`）。所有涉及 goal 的 spike（S1b/S2/S4）的 `threadStart` 必须显式传 `ephemeral: false`（覆盖 harness 默认的 `ephemeral: true`）。隔离不受影响——仍由 CODEX_HOME 承担（Task 1 已验证：thread 持久化落在临时 CODEX_HOME 的 sqlite，不碰生产）。S6 不建 goal，无需改。

---

### Task 1: app-server JSON-RPC 客户端 harness + 握手确认

建立后续所有 Codex spike 复用的最小客户端，并把 app-server 的真实握手序列（initialize / thread.start）确认下来落档。这是 S1a/S1b/S2/S4/S6 的公共依赖，也是未来 `goalRpc` 的原型。

**Files:**
- Create: `$REPO/spikes/goal-runtime-adapters-v2/lib/appserver-client.mjs`
- Create: `$REPO/spikes/goal-runtime-adapters-v2/probe-handshake.mjs`
- Create: `$REPO/docs/superpowers/spikes/2026-08-06-goal-runtime-adapters-v2-results.md`（决策矩阵，本 task 起头）

**Interfaces:**
- Produces:
  - `class AppServerClient` —— 构造 `new AppServerClient({ mode, sockPath, codexHome, cwd })`，`mode` ∈ `{'stdio','sock'}`；方法：
    - `async start()` → 启动/连接，返回 `void`（stdio 模式 spawn `codex app-server`；sock 模式连 `sockPath`）
    - `async rpc(method, params)` → `Promise<envelope>`，发一条 JSON-RPC 请求、按 `id` 匹配响应，返回完整响应对象 `{jsonrpc,id,result?|error?}`
    - `onNotification(cb)` → 注册通知回调 `cb({method, params})`（无 `id` 的消息）
    - `async initialize()` → 完成握手（见探测结论），返回 server 的 initialize 响应
    - `async threadStart(params = {})` → `rpc('thread/start', {ephemeral:true, ...params})`，返回 `{threadId, raw}`
    - `async stop()` → 关闭子进程/连接，返回 `void`
  - 命名导出 `readResults(path)` / `appendResult(path, row)` —— 决策矩阵行的读写（Markdown 表格追加），供后续 spike 复用

- [ ] **Step 1: 写 harness 骨架（stdio 模式 + 行分帧 JSON-RPC）**

创建 `spikes/goal-runtime-adapters-v2/lib/appserver-client.mjs`：

```javascript
import { spawn } from 'node:child_process';
import net from 'node:net';
import { appendFileSync, readFileSync } from 'node:fs';

// app-server 用 line-delimited JSON-RPC over stdio（每行一条 JSON）。
// sock 模式连 daemon 的 control socket，帧格式相同。
export class AppServerClient {
  constructor({ mode = 'stdio', sockPath, codexHome, cwd } = {}) {
    this.mode = mode;
    this.sockPath = sockPath;
    this.codexHome = codexHome;
    this.cwd = cwd;
    this._id = 0;
    this._pending = new Map();     // id -> {resolve, reject}
    this._notifyCbs = [];
    this._buf = '';
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
          this._pending.get(msg.id).resolve(msg);
          this._pending.delete(msg.id);
        } else if (msg.method) {
          for (const cb of this._notifyCbs) cb({ method: msg.method, params: msg.params });
        }
      }
    });
  }

  async start() {
    if (this.mode === 'stdio') {
      const env = { ...process.env };
      if (this.codexHome) env.CODEX_HOME = this.codexHome;
      // --listen stdio:// 是默认值，显式写防未来默认漂移（实测 0.146 help 确认）
      this._proc = spawn('codex', ['app-server', '--listen', 'stdio://'], { cwd: this.cwd, env, stdio: ['pipe', 'pipe', 'inherit'] });
      this._wire(this._proc.stdout, this._proc.stdin);
    } else {
      this._sock = net.createConnection(this.sockPath);
      await new Promise((res, rej) => { this._sock.once('connect', res); this._sock.once('error', rej); });
      this._wire(this._sock, this._sock);
    }
  }

  rpc(method, params = {}) {
    const id = ++this._id;
    const line = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this._writable.write(line);
      setTimeout(() => {
        if (this._pending.has(id)) { this._pending.delete(id); reject(new Error(`RPC timeout: ${method}`)); }
      }, 60000);
    });
  }

  onNotification(cb) { this._notifyCbs.push(cb); }

  async stop() {
    if (this._proc) this._proc.kill('SIGTERM');
    if (this._sock) this._sock.destroy();
  }
}

export function appendResult(path, row) {
  appendFileSync(path, row.endsWith('\n') ? row : row + '\n');
}
export function readResults(path) {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}
```

- [ ] **Step 2: 写握手探测脚本**

创建 `spikes/goal-runtime-adapters-v2/probe-handshake.mjs`：先试 `initialize`，再试 `thread/start`，把真实响应打印并落 fixture。initialize 的确切 params 未知——先发 `{}`，若 server 报错则按错误提示迭代（app-server 通常要 `{clientInfo:{name,version}}` 或空）。

```javascript
import { AppServerClient } from './lib/appserver-client.mjs';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'spike-handshake-'));
const codexHome = join(scratch, 'codex-home');
mkdirSync(codexHome, { recursive: true });
const client = new AppServerClient({ mode: 'stdio', codexHome, cwd: scratch });
await client.start();

const out = { codexHome };
try {
  // 探测 1：initialize（先空 params，失败再迭代）
  try {
    out.initialize = await client.rpc('initialize', { clientInfo: { name: 'goal-condition-spike', version: '0' } });
  } catch (e) { out.initializeError = String(e); }
  // 探测 2：thread/start ephemeral
  out.threadStart = await client.rpc('thread/start', { ephemeral: true, cwd: scratch, sandbox: 'read-only' });
  out.threadId = out.threadStart?.result?.thread?.threadId ?? out.threadStart?.result?.thread?.id;
} finally {
  writeFileSync(join(scratch, 'handshake.json'), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  console.log('SCRATCH=' + scratch);
  await client.stop();
}
```

- [ ] **Step 3: 跑握手探测，确认序列**

Run:
```bash
cd "$REPO" && node spikes/goal-runtime-adapters-v2/probe-handshake.mjs
```
Expected: 打印含 `threadId` 的 JSON。若 `initialize` 报 `method not found`，记录「无需 initialize」；若报缺字段，按错误补 params 重跑本步（这是握手探测的正常迭代）。**判定 PASS = 拿到非空 threadId**。

- [ ] **Step 4: 把确认的握手序列固化进 harness 的 `initialize()`/`threadStart()`**

根据 Step 3 的真实结果，在 `appserver-client.mjs` 补 `initialize()` 与 `threadStart()` 两方法（用实测的确切 params/响应路径）。例如若确认响应里 threadId 在 `result.thread.threadId`：

```javascript
async initialize() {
  // 若 Step 3 确认无需 initialize，本方法留空 return null 并注释说明
  const r = await this.rpc('initialize', { clientInfo: { name: 'goal-condition', version: '0' } });
  return r.result ?? r;
}
async threadStart(params = {}) {
  const r = await this.rpc('thread/start', { ephemeral: true, sandbox: 'read-only', cwd: this.cwd, ...params });
  const threadId = r.result?.thread?.threadId ?? r.result?.thread?.id;
  if (!threadId) throw new Error('thread/start returned no threadId: ' + JSON.stringify(r));
  return { threadId, raw: r };
}
```

- [ ] **Step 5: 起决策矩阵文档**

创建 `docs/superpowers/spikes/2026-08-06-goal-runtime-adapters-v2-results.md`：

```markdown
# goal-condition adapter v2 —— Spike 决策矩阵

> 每个 spike 的实测结论。PASS/FAIL 决定 spec §8 的路径与回退。
> 环境：codex-cli 0.146.0-alpha.9.2、claude 2.1.223（跑时以 `--version` 实测为准）。

## 握手确认（Task 1）
- app-server 连接方式：stdio 直连 `codex app-server`（行分帧 JSON-RPC）。
- initialize：<Step 3 结论——需要/不需要，确切 params>
- thread/start：ephemeral thread，threadId 在 `<响应路径>`。
- CODEX_HOME 隔离：<是否生效——goals sqlite 落在临时目录>。

## Spike 结果矩阵
| # | 验证 | 判定 | 证据锚点 | 对实现的影响 |
|---|---|---|---|---|
```

- [ ] **Step 6: Commit**

```bash
cd "$REPO"
git add spikes/goal-runtime-adapters-v2/lib/appserver-client.mjs \
        spikes/goal-runtime-adapters-v2/probe-handshake.mjs \
        docs/superpowers/spikes/2026-08-06-goal-runtime-adapters-v2-results.md
git commit -m "spike(goal): app-server RPC 客户端 harness + 握手确认"
```

---

### Task 2: S1a —— 外部设 complete + readback 可归因性

验证 `thread/goal/set {status:"complete"}` 能被外部接受、且 readback 一致；**同时实测 goal envelope 是否暴露 `goal_id`**（schema 显示 response 只有 `updatedAt`/`createdAt`，无 `goal_id`——这直接决定 spec §3 D5「set 带 goal_id 条件」能否落地，是必须落档的关键点）。

**Files:**
- Create: `$REPO/spikes/goal-runtime-adapters-v2/s1a-set-complete.mjs`
- Create: `$REPO/spikes/goal-runtime-adapters-v2/fixtures/s1a-set-complete.json`
- Modify: `$REPO/docs/superpowers/spikes/2026-08-06-goal-runtime-adapters-v2-results.md`（补一行矩阵）

**Interfaces:**
- Consumes: `AppServerClient`（Task 1）、`appendResult`（Task 1）

- [ ] **Step 1: 写 S1a 探测脚本**

```javascript
import { AppServerClient } from './lib/appserver-client.mjs';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'spike-s1a-'));
const codexHome = join(scratch, 'codex-home'); mkdirSync(codexHome, { recursive: true });
const c = new AppServerClient({ mode: 'stdio', codexHome, cwd: scratch });
await c.start(); await c.initialize();
const { threadId } = await c.threadStart();

const rec = { threadId };
try {
  rec.setActive = await c.rpc('thread/goal/set', { threadId, objective: 'Write DONE into ./out.txt then stop.', tokenBudget: 50000 });
  rec.setComplete = await c.rpc('thread/goal/set', { threadId, status: 'complete' });
  rec.getAfter = await c.rpc('thread/goal/get', { threadId });
  // 关键核查：envelope 是否含 goal_id
  const goal = rec.setComplete?.result?.goal ?? {};
  rec.goalKeys = Object.keys(goal);
  rec.hasGoalId = 'goalId' in goal || 'goal_id' in goal;
  rec.statusAfterComplete = rec.getAfter?.result?.goal?.status;
} finally {
  writeFileSync(join(process.env.REPO_FIX ?? '.', 's1a.json'), JSON.stringify(rec, null, 2));
  console.log('goalKeys=', JSON.stringify(rec.goalKeys));
  console.log('hasGoalId=', rec.hasGoalId, 'statusAfterComplete=', rec.statusAfterComplete);
  await c.stop();
}
```

- [ ] **Step 2: 跑 S1a**

Run:
```bash
cd "$REPO/spikes/goal-runtime-adapters-v2" && REPO_FIX=fixtures node s1a-set-complete.mjs
```
Expected: 打印 `goalKeys`（真实字段集）、`hasGoalId`、`statusAfterComplete`。

- [ ] **Step 3: 判读并落 fixture + 矩阵行**

把 `fixtures/s1a.json` 重命名/整理为 `fixtures/s1a-set-complete.json`（保留 setComplete/getAfter 两个真实 envelope）。判定：
- PASS 条件：外部 set complete 被接受（无 error）且 `statusAfterComplete === 'complete'`。
- **必记**：`hasGoalId` 的真假。若为假 → 决策矩阵「对实现的影响」列写：「§3 D5 的 goal_id 绑定在 RPC 层不可得，finalize 归因改用 `updatedAt` + `threadId` + set 返回 envelope 逐字段一致」。

在矩阵追加：
```markdown
| S1a | 外部设 complete + 可归因 | PASS/FAIL | s1a-set-complete.json:<字段> | goal_id 缺席→归因用 updatedAt+threadId |
```

- [ ] **Step 4: Commit**

```bash
cd "$REPO"
git add spikes/goal-runtime-adapters-v2/s1a-set-complete.mjs \
        spikes/goal-runtime-adapters-v2/fixtures/s1a-set-complete.json \
        docs/superpowers/spikes/2026-08-06-goal-runtime-adapters-v2-results.md
git commit -m "spike(goal): S1a 外部设 complete + goal_id 归因缺席核查"
```

---

### Task 3: S1b —— 非 active→active 拉回（条件 CASE 有闸的那半）

这是外环真正依赖的方向，也是二进制 SQL 证据指出的**会被静默吞**的那半。验证从 `budget_limited`/`complete` 用 `set {status:"active"}` 拉回是否真的生效，以及「同请求带 tokenBudget」变体能否解吞。

**Files:**
- Create: `$REPO/spikes/goal-runtime-adapters-v2/s1b-pull-active.mjs`
- Create: `$REPO/spikes/goal-runtime-adapters-v2/fixtures/s1b-pull-active.json`
- Modify: 决策矩阵

**Interfaces:**
- Consumes: `AppServerClient`、`appendResult`

- [ ] **Step 1: 写 S1b 探测脚本**

先把 goal 逼进一个非 active 态（最直接：`set {status:"complete"}` 或用极小 `tokenBudget` 触发 `budget_limited`），再尝试 `set {status:"active"}`，readback 比对是否真的回到 active；再试带 tokenBudget 抬升的变体。

```javascript
import { AppServerClient } from './lib/appserver-client.mjs';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'spike-s1b-'));
const codexHome = join(scratch, 'codex-home'); mkdirSync(codexHome, { recursive: true });
const c = new AppServerClient({ mode: 'stdio', codexHome, cwd: scratch });
await c.start(); await c.initialize();
const { threadId } = await c.threadStart({ ephemeral: false });   // goal 必须挂非 ephemeral thread（S1a 实测 -32600）
const rec = { threadId, cases: [] };

async function setGet(label, params) {
  const set = await c.rpc('thread/goal/set', { threadId, ...params });
  const get = await c.rpc('thread/goal/get', { threadId });
  const row = { label, requested: params, setStatus: set?.result?.goal?.status,
                getStatus: get?.result?.goal?.status, error: set?.error };
  rec.cases.push(row);
  console.log(label, '→ requested', params.status ?? '(objective)', '| get.status=', row.getStatus, '| err=', !!row.error);
  return row;
}

try {
  await setGet('create', { objective: 'Write DONE into ./out.txt then stop.', tokenBudget: 50000 });
  await setGet('to-complete', { status: 'complete' });
  await setGet('pull-active-plain', { status: 'active' });               // 会不会被粘滞吞？
  await setGet('to-budget', { status: 'budgetLimited' });                // 若不允许外部直设，记录 error
  await setGet('pull-active-with-budget', { status: 'active', tokenBudget: 1000000 }); // 带预算变体
} finally {
  writeFileSync(join(process.env.REPO_FIX ?? '.', 's1b.json'), JSON.stringify(rec, null, 2));
  await c.stop();
}
```

- [ ] **Step 2: 跑 S1b**

Run:
```bash
cd "$REPO/spikes/goal-runtime-adapters-v2" && REPO_FIX=fixtures node s1b-pull-active.mjs
```
Expected: 每个 case 打印 `requested` vs `get.status`。关注 `pull-active-plain` 后 `get.status` 是否真为 `active`。

- [ ] **Step 3: 判读并落 fixture + 矩阵**

整理 `fixtures/s1b-pull-active.json`。判定：
- **PASS（app-server 路径成立）**：`pull-active-plain` 或 `pull-active-with-budget` 后 `get.status === 'active'`——外环拉回有效。
- **FAIL（触发回退）**：两种拉回后 `get.status` 都不是 `active`（被条件 CASE 吞）→ 决策矩阵记「S1b FAIL，Codex 侧回退 exec 单发（spec §3 D3）」，并在「对实现的影响」写明哪个 case 被吞、requested 与 get 的差异。
- 无论 PASS/FAIL，都记录「set 响应的 status vs 随后 get 的 status 是否一致」——这决定 spec §4「set 后必须 readback」的必要性证据。

矩阵追加：
```markdown
| S1b | 拉回 active（条件 CASE 半） | PASS/FAIL | s1b-pull-active.json:cases | PASS→app-server 成立 / FAIL→回退 exec |
```

- [ ] **Step 4: Commit**

```bash
cd "$REPO"
git add spikes/goal-runtime-adapters-v2/s1b-pull-active.mjs \
        spikes/goal-runtime-adapters-v2/fixtures/s1b-pull-active.json \
        docs/superpowers/spikes/2026-08-06-goal-runtime-adapters-v2-results.md
git commit -m "spike(goal): S1b 拉回 active 实测条件 CASE 吞没（Codex 路径生死闸）"
```

---

### Task 4: S2 —— idle 续轮驱动 + 超预算恢复（生死闸真正实测）

验证两件都需要 goal **真实执行**的事：
- **(A) idle 续轮**：goal active 时线程 idle 是否触发自动续轮（无人值守续跑的底层前提）。
- **(B) 超预算恢复**（补 S1b 没能覆盖的生死闸场景）：goal 烧超 tokenBudget 转 `budgetLimited` 后——① 控制器 `set active` **不抬预算**是否被吞回 budgetLimited（坐实 spec §4「set 后必须 readback」的必要性：不抬预算的拉回会被静默吞，只有 readback 能发现）；② `set active` **+ 抬预算** 是否能真停在 active（坐实 spec §4「续跑抬预算」应对有效）。S1b 证明了 tokens_used=0 下拉回有效，B 补的正是 tokens_used≥budget 时 set RPC 的 `WHEN 请求=active AND tokens_used>=token_budget THEN 转走` 分支。

A、B 用**独立 thread**（大/小预算会互相干扰），同一 task 两个脚本。B 是本 task 的重点——它才是 Codex 生死闸的真正实测。

**Files:**
- Create: `$REPO/spikes/goal-runtime-adapters-v2/s2-idle-continuation.mjs`（A）
- Create: `$REPO/spikes/goal-runtime-adapters-v2/s2b-budget-recovery.mjs`（B）
- Create: `$REPO/spikes/goal-runtime-adapters-v2/fixtures/s2-idle-continuation.json`、`fixtures/s2b-budget-recovery.json`
- Modify: 决策矩阵

**Interfaces:**
- Consumes: `AppServerClient`、`appendResult`；订阅 `thread/goal/updated` 与 turn 相关通知
- ⚠️ **起首轮工作的 method 是 S2 的探测点**：goal set 后线程未必自动起 turn（S1b 实测 goal set 不触发执行、tokensUsed 全程 0）。两个脚本都需要一条「起始消息」把 goal 推入真实执行才能烧 token。该 method（`thread/run` / `thread/sendMessage` / `thread/inject-items` 之类）在 Task 1 握手的 server method 列表里找，或 S2 内迭代确认——**这是 S2 必须先解决的前置**，否则 A 观察不到续轮、B 烧不超预算。先确认它，再跑 A/B。

- [ ] **Step 1: 写 S2 探测脚本**

objective 设计成「至少两步、每步之间会自然 idle」的合成任务，用 `--sandbox workspace-write` 让它能写 scratch 文件；订阅所有通知，统计 turn 开始次数与 goal.updated 事件。设 90s wall-clock 观察窗。

```javascript
import { AppServerClient } from './lib/appserver-client.mjs';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'spike-s2-'));
const codexHome = join(scratch, 'codex-home'); mkdirSync(codexHome, { recursive: true });
const work = join(scratch, 'work'); mkdirSync(work, { recursive: true });
const c = new AppServerClient({ mode: 'stdio', codexHome, cwd: work });
await c.start(); await c.initialize();
const { threadId } = await c.threadStart({ ephemeral: false, sandbox: 'workspace-write', cwd: work });   // goal 必须挂非 ephemeral thread（S1a 实测 -32600）

const events = [];
c.onNotification((n) => { events.push({ t: Date.now(), method: n.method }); });

const rec = { threadId };
try {
  // 多步合成 objective：制造自然 idle 间隙
  rec.set = await c.rpc('thread/goal/set', { threadId,
    objective: 'Step 1: create ./a.txt containing X. Then in a later turn, Step 2: create ./b.txt containing Y. Do them in separate turns.',
    tokenBudget: 50000 });
  // 启动首轮工作（若 goal set 不自动起轮，用 thread 发一条起始消息——按握手确认的发消息 method 填）
  // 观察窗
  await new Promise((r) => setTimeout(r, 90000));
  rec.getFinal = await c.rpc('thread/goal/get', { threadId });
  rec.events = events;
  rec.turnStarts = events.filter((e) => /turn|started|item/i.test(e.method)).length;
  rec.goalUpdates = events.filter((e) => e.method === 'thread/goal/updated').length;
} finally {
  writeFileSync(join(process.env.REPO_FIX ?? '.', 's2.json'), JSON.stringify(rec, null, 2));
  console.log('distinct notify methods:', [...new Set(events.map((e) => e.method))]);
  console.log('turnStarts~', rec.turnStarts, 'goalUpdates=', rec.goalUpdates);
  await c.stop();
}
```

> 注：起首轮工作的确切 method（如 `thread/sendMessage` / `thread/run`）在 Task 1 握手时会一并暴露在 server 的 method 列表里；若 S2 首轮没起，先补发一条起始消息再观察 idle 续轮。这属 S2 探测内的正常迭代。

- [ ] **Step 2: 跑 S2（约 2 分钟）**

Run:
```bash
cd "$REPO/spikes/goal-runtime-adapters-v2" && REPO_FIX=fixtures node s2-idle-continuation.mjs
```
Expected: 打印出现过的通知 method 集合、粗略 turn 数、goalUpdates 数。

- [ ] **Step 3: 判读并落 fixture + 矩阵**

判定：
- **PASS**：观察窗内出现 ≥2 个明显 turn 边界（或 `./b.txt` 在无外部输入下被创建）→ idle 续轮成立。
- **FAIL**：只跑一轮就静止 → 决策矩阵记「S2 FAIL，Codex 回退 exec（idle 续轮不可依赖）」。
- **必记**：真实通知 method 名集合（实现阶段 `goalRpc` 订阅/轮询要用到）。落 `fixtures/s2-idle-continuation.json`。

矩阵追加：
```markdown
| S2 | idle 自动续轮 | PASS/FAIL | s2-idle-continuation.json:events | PASS→续跑靠 idle / FAIL→回退 exec+手动续 |
```

- [ ] **Step 4: 写 S2b 超预算恢复脚本**（生死闸真正实测）

用小 `tokenBudget` 逼 goal 烧超预算转 `budgetLimited`，再实测两种拉回。**前置**：先用 Step 1-3 确认的「起首轮」method 把 goal 推入真实执行（否则烧不超预算）。

```javascript
import { AppServerClient } from './lib/appserver-client.mjs';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'spike-s2b-'));
const codexHome = join(scratch, 'codex-home'); mkdirSync(codexHome, { recursive: true });
const work = join(scratch, 'work'); mkdirSync(work, { recursive: true });
const c = new AppServerClient({ mode: 'stdio', codexHome, cwd: work });
await c.start(); await c.initialize();
const { threadId } = await c.threadStart({ ephemeral: false, sandbox: 'workspace-write', cwd: work });
const rec = { threadId, phases: [] };
function snap(label, goal) {
  const row = { label, status: goal?.status, tokensUsed: goal?.tokensUsed, tokenBudget: goal?.tokenBudget };
  rec.phases.push(row); console.log(label, JSON.stringify(row)); return row;
}
try {
  // 小预算逼超；objective 是持续烧 token 的多轮任务
  const set = await c.rpc('thread/goal/set', { threadId,
    objective: 'Repeatedly append one timestamped line to ./log.txt, one line per turn, and keep going every turn.',
    tokenBudget: 2000 });
  snap('set', set.result?.goal);
  // ⚠️ 起首轮：用 Step 1-3 确认的 method 把 goal 推入真实执行（例：thread/inject-items 一条起始指令）
  //    该行按实测 method 填；未起 turn 则 tokensUsed 不增、烧不超预算，这一步必须成立。
  // 轮询等 budgetLimited（小预算应几轮内触发）
  let hitBudget = null;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 6000));
    const g = await c.rpc('thread/goal/get', { threadId });
    const row = snap(`poll-${i}`, g.result?.goal);
    if (row.status === 'budgetLimited') { hitBudget = row; break; }
    if (row.status === 'complete') break;
  }
  rec.reachedBudgetLimited = !!hitBudget;
  if (hitBudget) {
    // 拉回①：set active 不抬预算 → 应被吞回 budgetLimited（坐实 readback 必要性）
    const p1 = await c.rpc('thread/goal/set', { threadId, status: 'active' });
    snap('pull-no-raise(set)', p1.result?.goal);
    const g1 = await c.rpc('thread/goal/get', { threadId });
    const r1 = snap('pull-no-raise(readback)', g1.result?.goal);
    rec.swallowedWithoutRaise = r1.status !== 'active';
    // 拉回②：set active + 抬预算 → 应停在 active（坐实 spec §4 应对）
    const p2 = await c.rpc('thread/goal/set', { threadId, status: 'active', tokenBudget: (hitBudget.tokensUsed ?? 2000) + 50000 });
    snap('pull-with-raise(set)', p2.result?.goal);
    const g2 = await c.rpc('thread/goal/get', { threadId });
    const r2 = snap('pull-with-raise(readback)', g2.result?.goal);
    rec.recoveredWithRaise = r2.status === 'active';
  }
} finally {
  writeFileSync(join(process.env.REPO_FIX ?? '.', 's2b-budget-recovery.json'), JSON.stringify(rec, null, 2));
  console.log('reachedBudgetLimited=', rec.reachedBudgetLimited, 'swallowed(no raise)=', rec.swallowedWithoutRaise, 'recovered(with raise)=', rec.recoveredWithRaise);
  await c.stop();
}
```

- [ ] **Step 5: 跑 S2b（约 1-2 分钟）**

Run:
```bash
cd "$REPO/spikes/goal-runtime-adapters-v2" && REPO_FIX=fixtures node s2b-budget-recovery.mjs
```
Expected: 打印各 phase 的 status/tokensUsed，末行三个布尔。若 `reachedBudgetLimited=false`（小预算也没超，或 goal 直接 complete/未起 turn）→ 先解决「起首轮」前置或再调小 tokenBudget，这是 S2b 的正常迭代。

- [ ] **Step 6: 判读并落 fixture + 矩阵**（A idle 续轮 + B 超预算恢复，一并记）

判定：
- **S2(A) idle 续轮**：观察窗内 ≥2 turn 边界（或 `./b.txt` 无外部输入被创建）= PASS；只跑一轮静止 = FAIL（→ Codex 回退 exec 手动续）。
- **S2b(B) 超预算恢复**——三个坐实点：`reachedBudgetLimited=true`（前提：goal 真烧超预算）；`swallowedWithoutRaise=true`（set active 不抬预算被吞回 budgetLimited → **坐实 spec §4「set 后必须 readback」的必要性**，这正是 S1b 因 tokens_used=0 没测到的吞没分支）；`recoveredWithRaise=true`（抬预算能停在 active → 坐实 spec §4「续跑抬预算」应对有效）。三点任一不成立都如实记，并说明对 spec §4 的影响。
- **必记**：真实通知/turn method 名集合（实现阶段 goalRpc 订阅/轮询要用）。

矩阵追加：
```markdown
| S2  | idle 自动续轮      | PASS/FAIL       | s2-idle-continuation.json:events | PASS→续跑靠 idle / FAIL→回退 exec+手动续 |
| S2b | 超预算恢复(生死闸) | 见三坐实点        | s2b-budget-recovery.json:phases  | 坐实 spec §4 readback 强制 + 抬预算应对（S1b 未覆盖的吞没分支） |
```

- [ ] **Step 7: Commit**（两个脚本一起）

```bash
cd "$REPO"
git add spikes/goal-runtime-adapters-v2/s2-idle-continuation.mjs \
        spikes/goal-runtime-adapters-v2/s2b-budget-recovery.mjs \
        spikes/goal-runtime-adapters-v2/fixtures/s2-idle-continuation.json \
        spikes/goal-runtime-adapters-v2/fixtures/s2b-budget-recovery.json \
        docs/superpowers/spikes/2026-08-06-goal-runtime-adapters-v2-results.md
git commit -m "spike(goal): S2 idle 续轮 + S2b 超预算恢复实测（生死闸）"
```

---

### Task 5: S4 —— thread/inject 注入续跑 diagnostic

验证向既有 thread 注入「红项 diagnostic」消息（外环续跑的载体）的 RPC 姿态。`thread/inject-items` 已在 RPC 表面（params `{items, threadId}`），实测其 items 形状与注入后是否触发工作。

**Files:**
- Create: `$REPO/spikes/goal-runtime-adapters-v2/s4-inject.mjs`
- Create: `$REPO/spikes/goal-runtime-adapters-v2/fixtures/s4-inject.json`
- Modify: 决策矩阵

**Interfaces:**
- Consumes: `AppServerClient`

- [ ] **Step 1: 读 inject items 的确切形状**

Run:
```bash
cd "$REPO" && cat "$SCRATCH/appserver-schema/v2/ThreadInjectItemsParams.json" | python3 -m json.tool
```
把 `items` 的元素形状（很可能是 `{type:'text', text:'...'}` 类）记下来，填进下一步脚本。

- [ ] **Step 2: 写 S4 探测脚本**

```javascript
import { AppServerClient } from './lib/appserver-client.mjs';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scratch = mkdtempSync(join(tmpdir(), 'spike-s4-'));
const codexHome = join(scratch, 'codex-home'); mkdirSync(codexHome, { recursive: true });
const work = join(scratch, 'work'); mkdirSync(work, { recursive: true });
const c = new AppServerClient({ mode: 'stdio', codexHome, cwd: work });
await c.start(); await c.initialize();
const { threadId } = await c.threadStart({ ephemeral: false, sandbox: 'workspace-write', cwd: work });   // goal 必须挂非 ephemeral thread（S1a 实测 -32600）
const events = []; c.onNotification((n) => events.push(n.method));
const rec = { threadId };
try {
  rec.set = await c.rpc('thread/goal/set', { threadId, objective: 'Wait for corrective instructions, then follow them.', tokenBudget: 50000 });
  // items 形状按 Step 1 实测填写；下面是最可能的形状
  rec.inject = await c.rpc('thread/inject-items', { threadId,
    items: [{ type: 'text', text: 'Postflight failed: ./out.txt missing. Create it with content DONE, then stop.' }] });
  await new Promise((r) => setTimeout(r, 45000));
  rec.getFinal = await c.rpc('thread/goal/get', { threadId });
  rec.eventsAfterInject = [...new Set(events)];
} finally {
  writeFileSync(join(process.env.REPO_FIX ?? '.', 's4.json'), JSON.stringify(rec, null, 2));
  console.log('inject error?', !!rec.inject?.error, '| events:', rec.eventsAfterInject);
  await c.stop();
}
```

- [ ] **Step 3: 跑 S4**

Run:
```bash
cd "$REPO/spikes/goal-runtime-adapters-v2" && REPO_FIX=fixtures node s4-inject.mjs
```
Expected: `inject error? false` 且注入后出现工作类通知；`./out.txt` 在 work 目录被创建。

- [ ] **Step 4: 判读并落 fixture + 矩阵**

判定 PASS = inject 无 error 且触发了后续工作。落 `fixtures/s4-inject.json`（保留确认可用的 items 形状——实现阶段 `resumeSpec` 的 codex rpcOps 要用）。FAIL → 记「续跑注入需另找 method」。

矩阵追加：
```markdown
| S4 | inject 续跑 diagnostic | PASS/FAIL | s4-inject.json:inject | items 形状=<实测> |
```

- [ ] **Step 5: Commit**

```bash
cd "$REPO"
git add spikes/goal-runtime-adapters-v2/s4-inject.mjs \
        spikes/goal-runtime-adapters-v2/fixtures/s4-inject.json \
        docs/superpowers/spikes/2026-08-06-goal-runtime-adapters-v2-results.md
git commit -m "spike(goal): S4 thread/inject 注入续跑 diagnostic 实测"
```

---

### Task 6: S6 —— sock 访问壁垒（goalRpc 独占性的物理定级）

验证 codex 执行器（受 `--sandbox workspace-write` 约束的进程）能否 connect 到 daemon 的 control sock。这决定 spec §5「goalRpc controller 独占」是纯纪律还是有物理壁垒——进而决定 finalize receipt 可信还是降 audit_only。

**Files:**
- Create: `$REPO/spikes/goal-runtime-adapters-v2/s6-sock-barrier.mjs`
- Create: `$REPO/spikes/goal-runtime-adapters-v2/fixtures/s6-sock-barrier.json`
- Modify: 决策矩阵

**Interfaces:**
- Consumes: `AppServerClient`（sock 模式）

- [ ] **Step 1: 起 daemon 并定位 control sock**

Run:
```bash
cd "$REPO"
CODEX_HOME="$(mktemp -d)/ch" && mkdir -p "$CODEX_HOME"
CODEX_HOME="$CODEX_HOME" codex app-server daemon start 2>&1 | tee /tmp/s6-daemon.txt
CODEX_HOME="$CODEX_HOME" codex app-server daemon version 2>&1
# 从输出或已知约定定位 sock 路径（通常在 $CODEX_HOME 下）；记录到 fixture
ls -la "$CODEX_HOME" 2>/dev/null
```
把 sock 路径记下来（下一步脚本用）。**记住这个 CODEX_HOME 供 Step 4 stop daemon。**

- [ ] **Step 2: 写 S6 探测脚本——两个视角连同一 sock**

```javascript
// 视角 A：控制器直连 sock（应成功）——证明 sock 本身可用
// 视角 B：模拟执行器——在 codex exec 的 workspace-write sandbox 里跑一段 node，尝试 connect 同一 sock
import net from 'node:net';
import { writeFileSync } from 'node:fs';

const sock = process.argv[2];
if (!sock) { console.error('usage: s6-sock-barrier.mjs <sockPath>'); process.exit(2); }

function tryConnect(path) {
  return new Promise((resolve) => {
    const s = net.createConnection(path);
    s.once('connect', () => { s.destroy(); resolve({ connected: true }); });
    s.once('error', (e) => resolve({ connected: false, code: e.code }));
    setTimeout(() => { s.destroy(); resolve({ connected: false, code: 'TIMEOUT' }); }, 5000);
  });
}

const rec = { sock };
rec.controllerView = await tryConnect(sock);       // 视角 A
writeFileSync(process.env.REPO_FIX ? process.env.REPO_FIX + '/s6.json' : 's6.json', JSON.stringify(rec, null, 2));
console.log('controllerView:', JSON.stringify(rec.controllerView));
```

- [ ] **Step 3: 跑视角 A（控制器直连）**

Run:
```bash
cd "$REPO/spikes/goal-runtime-adapters-v2" && REPO_FIX=fixtures node s6-sock-barrier.mjs "<Step1 sock 路径>"
```
Expected: `controllerView: {"connected":true}`（sock 本身可用）。

- [ ] **Step 4: 跑视角 B（执行器 sandbox 内连 sock）**

用 `codex exec` 的 workspace-write sandbox 跑一段最小 node，尝试连同一 sock——这模拟执行器进程能否触达 goalRpc 通道：

```bash
cd "$REPO"
SOCK="<Step1 sock 路径>"
codex exec --sandbox workspace-write \
  "Run this exact node one-liner and report its stdout verbatim: node -e 'const net=require(\"net\");const s=net.createConnection(\"'$SOCK'\");s.on(\"connect\",()=>{console.log(\"EXECUTOR_CONNECTED\");s.destroy()});s.on(\"error\",e=>console.log(\"EXECUTOR_BLOCKED:\"+e.code));setTimeout(()=>process.exit(0),4000)'" \
  < /dev/null 2>&1 | tee /tmp/s6-executor.txt
grep -E "EXECUTOR_CONNECTED|EXECUTOR_BLOCKED" /tmp/s6-executor.txt || echo "NO_MARKER（判读见下）"
```
Expected: 出现 `EXECUTOR_CONNECTED`（挡不住）或 `EXECUTOR_BLOCKED:<code>`（挡得住）之一。

- [ ] **Step 5: 停 daemon + 判读 + 落矩阵**

```bash
CODEX_HOME="<Step1 的 CODEX_HOME>" codex app-server daemon stop 2>&1
```
判定：
- `EXECUTOR_BLOCKED` → sandbox 挡得住 sock → **finalize receipt 维持可信**，spec §5/§8 S6 结论「可信」。
- `EXECUTOR_CONNECTED` → 挡不住 → **finalize receipt 降 audit_only**，spec §5 信任声明按此更新。
把两个视角结果并含进 `fixtures/s6-sock-barrier.json`。

矩阵追加：
```markdown
| S6 | sock 访问壁垒 | BLOCKED/CONNECTED | s6-sock-barrier.json + /tmp/s6-executor.txt | receipt 可信 or 降 audit_only |
```

- [ ] **Step 6: Commit**

```bash
cd "$REPO"
git add spikes/goal-runtime-adapters-v2/s6-sock-barrier.mjs \
        spikes/goal-runtime-adapters-v2/fixtures/s6-sock-barrier.json \
        docs/superpowers/spikes/2026-08-06-goal-runtime-adapters-v2-results.md
git commit -m "spike(goal): S6 sock 访问壁垒实测（finalize receipt 物理定级）"
```

---

### Task 7: Claude 探针 harness + S3 —— Stop hook 续轮 + resume 继承

验证自建 command 型 Stop hook 在 `claude -p` 下的 block/allow 确切协议（JSON decision vs exit code 2），以及 `--resume` 续跑是否随 `--settings` 继承 hook。这是 Claude 侧路径的生死闸。

**Files:**
- Create: `$REPO/spikes/goal-runtime-adapters-v2/lib/claude-probe.mjs`（生成 settings + hook 脚本的辅助）
- Create: `$REPO/spikes/goal-runtime-adapters-v2/s3-hook-loop.mjs`
- Create: `$REPO/spikes/goal-runtime-adapters-v2/fixtures/s3-hook-loop.json`
- Modify: 决策矩阵

**Interfaces:**
- Produces: `writeHookSettings({dir, sentinelPath})` → 返回 `{settingsPath, hookPath, logPath}`；hook 脚本逻辑：sentinel 文件不存在 → block（要求继续），存在 → allow（放行停机）

- [ ] **Step 1: 写 Claude 探针辅助（生成 settings + Stop hook）**

创建 `lib/claude-probe.mjs`。Stop hook 用「达标 = sentinel 文件存在」模拟 postflight：

```javascript
import { writeFileSync, chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// 生成一个 command 型 Stop hook：sentinel 不存在→block（exit 2 或 JSON decision），存在→allow。
// 同时每次执行写一行 log，用于验证 hook 是否真的每轮触发（含 resume 轮）。
export function writeHookSettings({ dir, sentinelPath }) {
  mkdirSync(dir, { recursive: true });
  const hookPath = join(dir, 'stop-hook.sh');
  const logPath = join(dir, 'hook-runs.log');
  const settingsPath = join(dir, 'settings.json');
  const script = `#!/bin/bash
echo "hook-ran $(date +%s)" >> ${JSON.stringify(logPath)}
if [ -f ${JSON.stringify(sentinelPath)} ]; then
  exit 0
else
  echo '{"decision":"block","reason":"sentinel not created yet; create it then stop"}'
  exit 0
fi
`;
  writeFileSync(hookPath, script); chmodSync(hookPath, 0o500);
  const settings = { hooks: { Stop: [{ hooks: [{ type: 'command', command: hookPath }] }] } };
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return { settingsPath, hookPath, logPath };
}
```

> 注：Stop hook 的确切 block 协议（`{"decision":"block"}` JSON vs exit code 2）是本 spike 的探测点——脚本同时提供 JSON decision 与 exit 0，若不生效则 Step 3 迭代改成 `exit 2` + stderr reason，二者取实测生效的那个并记录。

- [ ] **Step 2: 写 S3 探测脚本**

```javascript
import { writeHookSettings } from './lib/claude-probe.mjs';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const scratch = mkdtempSync(join(tmpdir(), 'spike-s3-'));
const sentinel = join(scratch, 'DONE.sentinel');
const { settingsPath, logPath } = writeHookSettings({ dir: scratch, sentinelPath: sentinel });
const rec = { scratch };

function runClaude(args) {
  try { return { out: execFileSync('claude', args, { cwd: scratch, encoding: 'utf8', timeout: 180000 }) }; }
  catch (e) { return { err: String(e), out: e.stdout?.toString?.() ?? '' }; }
}

try {
  // 首发：目标 = 创建 sentinel 文件。hook 在 sentinel 缺席时 block、要求继续。
  const prompt = `Create an empty file at ${sentinel} using a shell command, then stop.`;
  const r1 = runClaude(['-p', prompt, '--output-format', 'json', '--settings', settingsPath,
    '--permission-mode', 'acceptEdits', '--max-turns', '8']);
  rec.firstRun = r1.out?.slice?.(0, 4000);
  rec.sentinelCreated = existsSync(sentinel);
  rec.hookRuns = existsSync(logPath) ? readFileSync(logPath, 'utf8').trim().split('\n').length : 0;
  // 解析 session_id 供 resume
  let sid; try { sid = JSON.parse(r1.out).session_id; } catch {}
  rec.sessionId = sid;
  // resume：删掉 sentinel，看 --resume + --settings 是否仍触发 hook（hookRuns 是否再增）
  if (sid) {
    try { execFileSync('rm', ['-f', sentinel]); } catch {}
    const before = rec.hookRuns;
    const r2 = runClaude(['-p', 'continue', '--resume', sid, '--output-format', 'json',
      '--settings', settingsPath, '--permission-mode', 'acceptEdits', '--max-turns', '8']);
    rec.resumeHookRuns = existsSync(logPath) ? readFileSync(logPath, 'utf8').trim().split('\n').length : 0;
    rec.hookRanOnResume = rec.resumeHookRuns > before;
  }
} finally {
  writeFileSync(join(process.env.REPO_FIX ?? '.', 's3.json'), JSON.stringify(rec, null, 2));
  console.log('sentinelCreated=', rec.sentinelCreated, 'hookRuns=', rec.hookRuns, 'hookRanOnResume=', rec.hookRanOnResume);
  await 0;
}
```

- [ ] **Step 3: 跑 S3**

Run:
```bash
cd "$REPO/spikes/goal-runtime-adapters-v2" && REPO_FIX=fixtures node s3-hook-loop.mjs
```
Expected: `sentinelCreated=true`、`hookRuns≥1`。若 hook 的 block 未生效（sentinel 一轮就被创建看不出 block 效果），改用「hook 要求写入特定内容、首轮故意提示模型只做一半」放大 block 观察，或把 hook 改 `exit 2`+stderr 重跑（探测正常迭代）。

- [ ] **Step 4: 判读并落 fixture + 矩阵**

判定：
- **S3 PASS（Stop hook 路径成立）**：hook 至少触发一次且 block/allow 语义可控（观察到「未达标→续轮→达标→停」）。
- **hookRanOnResume**：`--resume` 轮 hook 是否随 `--settings` 再次触发——决定 spec §5「resumeSpec 强制复用 --settings」是否够、是否有额外坑。
- **S3 FAIL**：hook 完全不触发或 block 无效 → Claude 侧回退裸 `-p` 单发（spec §8）。
- 记录确认生效的 block 协议（JSON decision 还是 exit 2）。落 `fixtures/s3-hook-loop.json`。

矩阵追加：
```markdown
| S3 | Stop hook 续轮 + resume 继承 | PASS/FAIL | s3-hook-loop.json | 生效协议=JSON/exit2；resume 继承=真/假 |
```

- [ ] **Step 5: Commit**

```bash
cd "$REPO"
git add spikes/goal-runtime-adapters-v2/lib/claude-probe.mjs \
        spikes/goal-runtime-adapters-v2/s3-hook-loop.mjs \
        spikes/goal-runtime-adapters-v2/fixtures/s3-hook-loop.json \
        docs/superpowers/spikes/2026-08-06-goal-runtime-adapters-v2-results.md
git commit -m "spike(goal): S3 Stop hook 续轮 + resume 继承实测（Claude 路径生死闸）"
```

---

### Task 8: S5 —— settings deny 真实防护面 + Bash 旁路探针

验证 `--settings` 对 hook 脚本路径的 Write/Edit deny 实际能挡什么、挡不住什么——尤其**执行器能否用 Bash 改写 hook 脚本**（四源审核 KR3：deny 只在工具层，Bash 旁路可绕）。结果决定 spec 把 hook 保护定级为「物理」还是「观测性防线」（spec 已按观测性写就，S5 只影响措辞强度）。

**Files:**
- Create: `$REPO/spikes/goal-runtime-adapters-v2/s5-deny-surface.mjs`
- Create: `$REPO/spikes/goal-runtime-adapters-v2/fixtures/s5-deny-surface.json`
- Modify: 决策矩阵

**Interfaces:**
- Consumes: `writeHookSettings`（Task 7）

- [ ] **Step 1: 写 S5 探测脚本——两条改写路径**

给 settings 加对 hook 路径的 Write/Edit deny，然后让 claude 分别用「Edit 工具」和「Bash」尝试改写 hook 脚本，看各自结果：

```javascript
import { writeHookSettings } from './lib/claude-probe.mjs';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const scratch = mkdtempSync(join(tmpdir(), 'spike-s5-'));
const sentinel = join(scratch, 'DONE.sentinel');
const { settingsPath, hookPath } = writeHookSettings({ dir: scratch, sentinelPath: sentinel });
// 给 settings 加 hook 路径的 Write/Edit deny
const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
settings.permissions = { deny: [`Write(${hookPath})`, `Edit(${hookPath})`] };
writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
const original = readFileSync(hookPath, 'utf8');

function runClaude(prompt, extra = []) {
  try { return execFileSync('claude', ['-p', prompt, '--output-format', 'json', '--settings', settingsPath,
    '--permission-mode', 'acceptEdits', '--max-turns', '4', ...extra],
    { cwd: scratch, encoding: 'utf8', timeout: 120000 }); }
  catch (e) { return e.stdout?.toString?.() ?? String(e); }
}

const rec = { hookPath };
// 路径 A：用 Edit 工具改写（应被 deny 挡）
runClaude(`Use your Edit tool to replace the entire contents of ${hookPath} with the text "exit 0". If blocked, say BLOCKED.`);
rec.afterEditAttempt = readFileSync(hookPath, 'utf8');
rec.editChanged = rec.afterEditAttempt !== original;
// 恢复
writeFileSync(hookPath, original);
// 路径 B：用 Bash 改写（四源审核预测 deny 挡不住）
runClaude(`Run this shell command via Bash: printf 'exit 0\\n' > ${hookPath}. If blocked, say BLOCKED.`);
rec.afterBashAttempt = readFileSync(hookPath, 'utf8');
rec.bashChanged = rec.afterBashAttempt !== original;

writeFileSync(join(process.env.REPO_FIX ?? '.', 's5.json'), JSON.stringify(rec, null, 2));
console.log('editChanged(应 false)=', rec.editChanged, '| bashChanged(预测 true)=', rec.bashChanged);
```

- [ ] **Step 2: 跑 S5**

Run:
```bash
cd "$REPO/spikes/goal-runtime-adapters-v2" && REPO_FIX=fixtures node s5-deny-surface.mjs
```
Expected: `editChanged=false`（Edit 被 deny 挡）、`bashChanged` 的真实值（验证 Bash 旁路是否成立）。

- [ ] **Step 3: 判读并落 fixture + 矩阵**

判定并记录：
- `editChanged=false` 且 `bashChanged=true` → 坐实 KR3：deny 只挡工具层，Bash 旁路有效 → spec/adapter 保持「hook 保护是观测性防线，非物理」表述，且 §7 的「hook 篡改探针」测试必含 Bash 旁路用例。
- 若 `bashChanged=false`（deny 意外也挡住了 Bash）→ 记录反常，需复核 permission deny 的匹配语义再定级。
落 `fixtures/s5-deny-surface.json`。

矩阵追加：
```markdown
| S5 | deny 防护面 + Bash 旁路 | editChanged/bashChanged | s5-deny-surface.json | hook 保护=观测性（非物理） |
```

- [ ] **Step 4: Commit**

```bash
cd "$REPO"
git add spikes/goal-runtime-adapters-v2/s5-deny-surface.mjs \
        spikes/goal-runtime-adapters-v2/fixtures/s5-deny-surface.json \
        docs/superpowers/spikes/2026-08-06-goal-runtime-adapters-v2-results.md
git commit -m "spike(goal): S5 settings deny 防护面 + Bash 旁路实测（KR3 定级）"
```

---

### Task 9: 汇总决策矩阵 + spec §8 结果回填

把 7 个 spike 的 PASS/FAIL 汇成一张判决表，据此确定两条路径的最终形状（app-server 全量 vs 回退 exec；Stop hook vs 回退裸 -p；finalize receipt 可信 vs audit_only），并把结论回填进 spec §8，供实现阶段（Plan 2）直接引用。

**Files:**
- Modify: `$REPO/docs/superpowers/spikes/2026-08-06-goal-runtime-adapters-v2-results.md`（补「路径判决」节）
- Modify: `$REPO/docs/superpowers/specs/2026-08-06-goal-runtime-adapters-v2-design.md`（§8 补「spike 实测结果」子节）

- [ ] **Step 1: 汇总矩阵并写路径判决**

在决策矩阵文档末尾追加：

```markdown
## 路径判决（据 7 spike 实测）

- Codex 侧：S1b + S2 均 PASS → **app-server 全量对接成立**；任一 FAIL → 回退 exec 单发（含状态机降级开关，spec §3 D3）。实测：<填 PASS/FAIL 与结论>。
- Claude 侧：S3 PASS → **Stop hook 续轮成立**；FAIL → 回退裸 -p 单发 + resume 外环。实测：<填>。
- finalize receipt 定级：S6 = BLOCKED → 可信；CONNECTED → audit_only。实测：<填>。
- goal_id 归因（S1a）：<goal_id 是否 RPC 可见；finalize 归因字段最终取 updatedAt+threadId 还是含 goal_id>。
- 续跑注入（S4）：items 形状 = <实测>。
- hook block 协议（S3）：<JSON decision / exit 2>；resume hook 继承 = <真/假>。

## 对 Plan 2（实现阶段）的输入
逐条列出 spike 结论如何钉死实现细节（normalizeTerminal 的 Codex 事件源、resumeSpec 的 rpcOps、goalRpc 的 readback 归因字段、hook settings 的 block 协议、S6 决定的 receipt 级别）。
```

- [ ] **Step 2: 回填 spec §8**

在 spec §8 表格后新增一子节「### spike 实测结果（2026-08-06）」，把路径判决的关键结论（哪条 PASS/FAIL、触发了哪个回退、receipt 定级、goal_id 归因修正）逐条写入，引用决策矩阵文档路径。若 S1b/S2 FAIL 触发 Codex 回退，把 spec §3 D3 的回退从「预案」标注为「已生效」。

- [ ] **Step 3: Commit**

```bash
cd "$REPO"
git add docs/superpowers/spikes/2026-08-06-goal-runtime-adapters-v2-results.md \
        docs/superpowers/specs/2026-08-06-goal-runtime-adapters-v2-design.md
git commit -m "spike(goal): 汇总 7-spike 决策矩阵 + spec §8 结果回填"
```

- [ ] **Step 4: 交接提示**

在决策矩阵文档顶部写一句：「本阶段结论已定；实现阶段（Plan 2）由 writing-plans 依据本矩阵重新展开 launch.mjs / adapters / hook 生成器 / workflow 改绑 / 文档同步 / manifest 同步 / re-pin。」向用户报告 spike 结果，等其决定是否进 Plan 2。

---

## 自审（写完计划后的一次性检查）

**1. Spec 覆盖**：本计划覆盖 spec §8 的全部 7 个 spike（S1a/S1b/S2/S3/S4/S5/S6），并新增了 S1a 的 goal_id 归因核查（源于读 schema 发现 RPC 层无 goal_id，是对 spec §3 D5 的必要实测校正）。实现类改动（launch.mjs、adapters、workflow 改绑、文档/manifest 同步）**刻意不在本计划**——它们被 spike 结果 gate，属 Plan 2。

**2. 占位符扫描**：脚本代码均为可跑的真实实现；「握手 method 名/inject items 形状/hook block 协议」三处标注为**探测点**（spike 的本质是测未知），并各配了迭代指令与判读锚点，不是含糊的 TODO。

**3. 类型一致**：`AppServerClient` 的方法签名（start/rpc/onNotification/initialize/threadStart/stop）在 Task 1 定义，Task 2-6 一致复用；`writeHookSettings` 在 Task 7 定义，Task 8 复用；决策矩阵路径全程一致。

**4. 歧义**：每个 spike 的 PASS/FAIL 判据都给了可观测量（status 字段值、文件是否创建、连接 code、hook log 行数），无「合理即可」类模糊判定。
