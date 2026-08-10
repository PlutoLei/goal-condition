# goal-condition adapter v2 —— Spike 决策矩阵

> 每个 spike 的实测结论。PASS/FAIL 决定 spec §8 的路径与回退。
> 环境：codex-cli 0.146.0-alpha.9.2、claude 2.1.223（跑时以 `--version` 实测为准）。

## 握手确认（Task 1）

- app-server 连接方式：stdio 直连 `codex app-server --listen stdio://`（行分帧 JSON-RPC，`--listen stdio://` 是当前版本默认值，显式写防未来默认漂移）。
- initialize：**必须**。实测跳过 `initialize` 直接发 `thread/start` 会被拒绝，返回 JSON-RPC 错误 `{"code": -32600, "message": "Not initialized"}`。请求需带 `clientInfo`（`name`+`version` 必填，schema `InitializeParams.required = ["clientInfo"]`）；`capabilities` 字段可选未测。成功响应示例：
  ```json
  {
    "userAgent": "goal-condition-spike/0.146.0-alpha.9.2 (Mac OS 26.3.0; arm64) <HOST_APP>/<VERSION> (goal-condition-spike; 0)",
    "codexHome": "<注入的 CODEX_HOME>",
    "platformFamily": "unix",
    "platformOs": "macos"
  }
  ```
  没有独立的 `InitializeResponse` schema 文件（`generate-json-schema --experimental` 产物里 `InitializeResponse` 为 `null`），响应形状以实测为准。
- thread/start：ephemeral thread，threadId 在 **`result.thread.id`**（不是 `threadId`——`ThreadStartResponse` 的 schema 里 `Thread` 定义只有 `id` 字段，没有 `threadId`；brief 草稿里的 `result?.thread?.threadId` 假设是错的，已用 `?? result?.thread?.id` 兜底并实测确认走的是兜底分支）。响应还带 `model`/`modelProvider`/`sandbox`/`approvalPolicy` 等会话元信息。
- CODEX_HOME 隔离：**生效**，双重证据——① `initialize` 响应里的 `codexHome` 字段原样回显了注入的临时目录路径；② 探测后临时目录下真实生成了独立的 `goals_1.sqlite`（含 `-wal`/`-shm`），与生产 `~/.codex/goals_1.sqlite` 完全分离，未触碰生产库。

### 探测脚本实际输出摘录

```
$ node spikes/goal-runtime-adapters-v2/probe-handshake.mjs
{
  "codexHome": "/var/folders/.../spike-handshake-tERF1f/codex-home",
  "initialize": {
    "id": 1,
    "result": {
      "userAgent": "goal-condition-spike/0.146.0-alpha.9.2 (Mac OS 26.3.0; arm64) <HOST_APP>/<VERSION> (goal-condition-spike; 0)",
      "codexHome": "/private/var/folders/.../spike-handshake-tERF1f/codex-home",
      "platformFamily": "unix",
      "platformOs": "macos"
    }
  },
  "threadStart": {
    "id": 2,
    "result": {
      "thread": { "id": "00000000-0000-4000-8000-000000000001", "ephemeral": true, ... },
      "model": "gpt-5.6-sol",
      "sandbox": { "type": "readOnly", "networkAccess": false },
      ...
    }
  },
  "threadId": "00000000-0000-4000-8000-000000000001"
}
SCRATCH=/var/folders/.../spike-handshake-tERF1f
```

PASS：`threadId` 非空。跳过 `initialize` 的对照探测（未纳入正式脚本，另跑一次性验证）返回 `{"error":{"code":-32600,"message":"Not initialized"}}`，证实 initialize 是硬性前置而非可选握手。

### 已知问题（非阻断，已修）

`appserver-client.mjs` 的 `rpc()` 里 `setTimeout(...,60000)` 若不 `.unref()`，即使请求已成功 resolve，悬空 timer 仍会把 Node 进程挂到 60s 超时后才能自然退出——每次调用 `rpc()` 都会拖慢一次。已加 `.unref()` 修正（不改变超时判定逻辑，只是不再阻塞进程退出），修正前后对照：`probe-handshake.mjs` 从稳定耗时 ~60s 降到 ~0.1s。下游 S1a/S1b/S2/S4/S6 若发现脚本"卡住不退出"，先查是否用了未 unref 的旧版 harness。

## S1a：外部设 complete + goal_id 归因缺席核查（Task 2）

- **前置障碍（已解决）**：`threadStart()` 默认 `ephemeral: true`，goal RPC 一律拒绝，返回 `{"code": -32600, "message": "ephemeral thread does not support goals: <id>"}`——`thread/goal/set`/`thread/goal/get` 全部命中，不是 goal 本身的问题。改传 `{ ephemeral: false }` 后三个 RPC 均成功。`codexHome` 仍是本次 spike 的临时目录，goal 状态持久化到该隔离目录下，不破隔离铁律。**这本身是对实现有意义的发现：goal 生命周期绑定非 ephemeral（持久化）thread，adapter 若要用 ephemeral thread 做一次性任务则无法挂 goal。**
- **goal_id 核查（schema + 实测双重确认）**：`codex app-server generate-json-schema --out <dir> --experimental` 产出的 `ThreadGoal`（`ThreadGoalSetResponse`/`ThreadGoalGetResponse` 共用）必填字段为 `createdAt/objective/status/threadId/timeUsedSeconds/tokensUsed/updatedAt`，可选 `tokenBudget`——**没有 `goal_id`/`goalId`**。实测 `setComplete.result.goal` 的 `Object.keys()` 与 schema 完全吻合（`["threadId","objective","status","tokenBudget","tokensUsed","timeUsedSeconds","createdAt","updatedAt"]`），`hasGoalId === false`。goal_id 在 SQL 表层存在但 RPC envelope 从不暴露，不是这次探测的偶然遗漏，是协议设计如此。
- **归因 fallback 的额外风险（新发现，brief 未预判）**：`updatedAt` 是秒级（Unix seconds）整数。本次 setActive → setComplete 两次 RPC 在同一 wall-clock 秒内完成，两条记录的 `updatedAt`（以及 `createdAt`）完全相同（`1786000451`）。若 finalize 归因改用 `updatedAt + threadId`，对短时间内连续多次 set 调用（同一秒发生两次以上状态迁移）无法区分先后——`updatedAt` 单独不足以做严格递增的归因锚点，需要额外拿 `status` 转移序列或客户端侧序列号兜底，不能只判等值匹配。
- PASS 判据：外部 `set {status:'complete'}` 被接受（响应无 `error`）且 `getAfter.result.goal.status === 'complete'`——两者均成立。

### S1a 脚本实际输出摘录

```
$ REPO_FIX=fixtures node s1a-set-complete.mjs
goalKeys= ["threadId","objective","status","tokenBudget","tokensUsed","timeUsedSeconds","createdAt","updatedAt"]
hasGoalId= false statusAfterComplete= complete
```

完整 envelope（`setActive`/`setComplete`/`getAfter` 三个真实响应）见 `spikes/goal-runtime-adapters-v2/fixtures/s1a-set-complete.json`。

## S1b：拉回 active（条件 CASE 半，Codex 侧生死闸）（Task 3）

- **前提**：本 spike 的框架预期是验证「二进制 SQL 证据」指出的会被静默吞的那半——即从 `complete`/`budgetLimited` 用外部 `thread/goal/set {status:'active'}` 拉回，理论上会被 app-server 内部的条件 CASE UPDATE 吞掉（写入被判定为非法转移而静默 no-op）。
- **实测序列**：`create`(active) → `to-complete`(complete) → `pull-active-plain`(active) → `to-budget`(budgetLimited) → `pull-active-with-budget`(active, tokenBudget:1000000)。每步都做 `set` 后独立 `thread/goal/get` readback，脚本内部连续跑 3 次（`RUN_COUNT=3`，每次全新 `mkdtemp` scratch + 全新 `CODEX_HOME`），全部落入同一 fixture。
- **结果：两种拉回都成功**，不是「被吞」。`pull-active-plain`（从 `complete` 直接 set `active`，不带 tokenBudget）与 `pull-active-with-budget`（从 `budgetLimited` set `active` 并带新 `tokenBudget`）在 `set` 响应与随后 `get` 中的 `status` 均为 `active`，与请求值一致。3 次独立跑（`run 0`/`run 1`/`run 2`）的 `setStatus`/`getStatus` 序列逐行相同、无一次出现 `error` 字段——不是竞态偶然，是确定性行为（三次原始输出见下方摘录，未省略）。
- **关键前提：`tokensUsed` 全程为 0（review 后补测，坐实而非推断）**。CASE 闸真正的守卫条件是 `tokens_used >= token_budget`；本次 goal 从未跑过任何 turn，`tokensUsed` 在 3 次跑、15 组 case（含 `create`/`to-complete`/`pull-active-plain`/`to-budget`/`pull-active-with-budget`）里全部实测为 `0`，`tokenBudget` 全程 >0，守卫条件恒假。**这意味着本次 PASS 证明的是「守卫未触发时外部拉回有效」，不是「守卫触发后 CASE 闸仍放行」**——后者需要真实 turn 执行把 `tokensUsed` 推到预算之上才能测到，不在本次 S1b 范围内（team lead 已采纳，纳入后续 S2 扩展）。
- **set vs get 一致性**：3 次运行、共 15 组 case，`set` 响应回显的 `status`/`tokensUsed` 与随后 `get` readback 的对应字段 **逐一相等，零例不一致**。就本次探测覆盖的场景而言，没有实测证据支撑「set 后必须 readback」是硬性必要（但作为防御性设计仍可保留，只是必要性论据本次没坐实）。
- **判定：PASS**（判据：`pull-active-plain` 与 `pull-active-with-budget` 后 `get.status === 'active'`，两者均成立，3 次独立跑复现一致）。判定范围明确限定在「`tokens_used=0`、CASE 闸守卫未触发」这一前提下——见上一条。

### S1b 脚本实际输出摘录（3 次独立跑，完整未省略）

```
$ REPO_FIX=fixtures node s1b-pull-active.mjs
[run 0] create → requested (objective) | get.status= active | get.tokensUsed= 0 | err= false
[run 0] to-complete → requested complete | get.status= complete | get.tokensUsed= 0 | err= false
[run 0] pull-active-plain → requested active | get.status= active | get.tokensUsed= 0 | err= false
[run 0] to-budget → requested budgetLimited | get.status= budgetLimited | get.tokensUsed= 0 | err= false
[run 0] pull-active-with-budget → requested active | get.status= active | get.tokensUsed= 0 | err= false
[run 1] create → requested (objective) | get.status= active | get.tokensUsed= 0 | err= false
[run 1] to-complete → requested complete | get.status= complete | get.tokensUsed= 0 | err= false
[run 1] pull-active-plain → requested active | get.status= active | get.tokensUsed= 0 | err= false
[run 1] to-budget → requested budgetLimited | get.status= budgetLimited | get.tokensUsed= 0 | err= false
[run 1] pull-active-with-budget → requested active | get.status= active | get.tokensUsed= 0 | err= false
[run 2] create → requested (objective) | get.status= active | get.tokensUsed= 0 | err= false
[run 2] to-complete → requested complete | get.status= complete | get.tokensUsed= 0 | err= false
[run 2] pull-active-plain → requested active | get.status= active | get.tokensUsed= 0 | err= false
[run 2] to-budget → requested budgetLimited | get.status= budgetLimited | get.tokensUsed= 0 | err= false
[run 2] pull-active-with-budget → requested active | get.status= active | get.tokensUsed= 0 | err= false
```

完整 3 次跑 × 5 个 case 的 `requested`/`setStatus`/`setTokensUsed`/`getStatus`/`getTokensUsed` 见 `spikes/goal-runtime-adapters-v2/fixtures/s1b-pull-active.json`（结构：`{ runs: [ {threadId, cases:[...]}, {...}, {...} ] }`）。

## 起首轮 method（S2/S2b 头号前置，Task 4 实测结论）

- **goal set 本身不触发执行**（S1b 已实测：全程 `tokensUsed=0`）。真正把 goal 推入执行的 method 是 **`turn/start`**（`TurnStartParams: {threadId, input:[UserInput]}`，`UserInput` 最简形式 `{type:'text', text:'...'}`）——这是从 `codex app-server generate-json-schema --experimental` 产出的 `ClientRequest.json`（枚举全部 96 个 client method 到各自 Params 的映射）与 `ServerNotification.json`（枚举全部 server 通知 method）里静态核对出来的，不是猜测；再用一个独立探测脚本实测确认：调用一次 `turn/start` 后，`turn/started`→`item/started`(fileChange)→`turn/completed` 全套通知按序出现，磁盘上真的生成了文件，`thread/goal/updated` 携带的 `tokensUsed` 从 0 变为非零。
- **第二个前置障碍（预探测中发现，brief 未预判）**：隔离的 `CODEX_HOME`（fail-closed 硬闸，Task 1 定的隔离铁律）默认没有认证信息，`turn/start` 会在后台反复 `401 Unauthorized`（`Missing bearer or basic authentication`），goal 永远看不到真实 token 消耗、观察不到任何真实执行。解法：**只读复制生产 `~/.codex/auth.json`（OAuth token）到隔离的 `codexHome` 目录**，不碰 `goals_1.sqlite`/`config.toml`/其余生产状态——隔离铁律保护的是"状态不串"（goal 记录、会话历史），不是认证凭证本身；复制后 `turn/start` 立即跑通真实 turn。S2/S2b 两个脚本都内联了这段复制逻辑（未改动共享 harness `appserver-client.mjs`，改动范围与 brief Step 7 的提交清单一致）。
- **fix round 1（review 补的两处安全加固，S4/S6 复用这套 auth-copy 模式前必须一并对）**：① 两脚本原来跑完不清理临时目录，生产 `auth.json` 的明文副本会残留在 `/var/folders` 下，不能指望 OS 清理时机，已在 `finally` 里加 `rmSync` 主动删除。② `codexHome`（含 `auth.json`）与 `work`（AI 执行体的 sandbox cwd）原来是同一 scratch 目录下的兄弟子目录，`workspace-write` sandbox 只限写不限读，执行体理论上能用相对路径读到凭证——已改成两个互相独立、路径不可预测的 `mkdtempSync()` 目录。两处修复后重跑复现：S2/S2b 判定不变（仍 PASS/三坐实点全真），临时目录清理生效（`find` 复核为空），`codexHome`/`work` 不再共享父目录。
- **副产品发现**：`goal.tokensUsed` 不是 `thread/tokenUsage/updated` 里的原始 `totalTokens`，用实测数值反推吻合 `(inputTokens - cachedInputTokens) + outputTokens`（即只计"非缓存"部分）——一次触发单个文件写入的最简单 turn 就已经消耗 `tokensUsed≈8000` 量级（system prompt + 工具声明等固定开销占大头）。这解释了为什么 S2b 用 `tokenBudget:2000` 时单轮就能烧穿：预算刻意设得比单轮固定开销还低，不需要多轮累积。

## S2：idle 续轮驱动（Task 4）

- **脚本**：`spikes/goal-runtime-adapters-v2/s2-idle-continuation.mjs`。objective 明确写成两步且显式要求"分开轮次"（`Step 1: create ./a.txt... Then in a later turn, Step 2: create ./b.txt... after finishing step 1, end your turn and stop — do not start step 2 yourself in this same turn.`），`tokenBudget:50000`（充裕，避免预算耗尽混入变量）。**全程只调用一次 `turn/start`**，之后 90s 纯被动订阅通知，不再发任何驱动性 RPC——这是本次要测的问题本身：不再手动催的情况下，服务端会不会自己再起下一个 turn。
- **结果：PASS，且是强证据、非边缘判定**。虽然客户端只调用了 1 次 `turn/start`，但事件流里出现了 **2 次 `turn/started` + 2 次 `turn/completed`**（`turnStartedCount=2`），`thread/goal/updated` 共 9 次。文件系统给出独立佐证：scratch work 目录下 `a.txt`（内容 `X`，mtime 16:37:35）与 `b.txt`（内容 `Y`，mtime 16:37:52）**都真实生成**，不是同一个 turn 里模型自己把两步都做完——两次 `turn/started`/`turn/completed` 对应两次独立执行。goal 最终 `status:"complete"`，`tokensUsed:23353`（两轮累计）。（以上为 fix round 1 后重跑的数值；fix 前首跑同样 PASS，`tokensUsed:11696`，两次独立真实调用数值不同属预期，判定结论一致。）
- **精确的时序细节（比"idle 续轮"这个词面意思更值得记录）**：第一个 `turn/completed` 发生在相对时间 40548ms，第二个 `turn/started` 紧接着在 40561ms 出现——**间隔仅 13ms**，是近乎瞬时的链式续轮，不是"等了一段真正的静默/idle 时间之后服务端才决定恢复"。（两次独立跑——首跑与 fix round 1 重跑——测得的间隔都是 13ms，不是偶然。）换句话说，观察到的机制更准确的描述是"goal 执行器在 turn 完成、goal 仍 active 且目标未达成时立即自动链起下一个 turn"，而不是"检测到 thread 处于 idle 状态一段时间后触发续轮"——对 spec 里"idle 续轮"这个提法建议改措辞为"目标未达成时自动续轮"，避免暗示存在一个可配置的 idle 阈值（本次探测没有证据支持有这样一个阈值，只观察到「立即续」）。
- **必记的真实通知 method 集合**（实现阶段 `goalRpc` 订阅要用）：`thread/started`、`mcpServer/startupStatus/updated`、`thread/goal/updated`、`thread/status/changed`、`turn/started`、`item/started`、`item/completed`、`item/agentMessage/delta`、`turn/diff/updated`、`thread/tokenUsage/updated`、`account/rateLimits/updated`、`turn/completed`。判断"新 turn 边界"应订阅 `turn/started`/`turn/completed`，不能靠猜测的 `/item/i` 之类的宽泛正则（brief 草稿里的 `/turn|started|item/i.test` 会把 `thread/started`、`item/*` 也计进去，需要精确匹配 method 名）。

## S2b：超预算恢复（生死闸真正实测）（Task 4）

- **脚本**：`spikes/goal-runtime-adapters-v2/s2b-budget-recovery.mjs`。`tokenBudget:2000`（刻意小于单轮固定开销），objective 是"每轮追加一行时间戳、持续下去"。同样只调用一次 `turn/start` 起首轮（S2 已证实服务端会自动链式续轮，不需要手动循环调用）。
- **三个坐实点，全部为真**：
  - `reachedBudgetLimited = true`：`poll-3`（起轮后约 24s）读到 `status:"budgetLimited"`，`tokensUsed:8291`（单轮固定开销就已超过 2000 的预算，不需要多轮累积；以上为 fix round 1 后重跑数值，首跑为 8283，两次独立真实调用数值相近属预期）。work 目录下 `log.txt` 有一行时间戳（重跑；首跑为两行、10 秒间隔），与 S2 证实的自动链式续轮一致，未细分，不影响本坐实点判定。
  - `swallowedWithoutRaise = true`：`thread/goal/set {threadId, status:'active'}`（不带 `tokenBudget`）后，**set 响应本身**的 `result.goal.status` 就是 `"budgetLimited"`（不是 `"active"`），随后独立 `get` readback 同样是 `"budgetLimited"`。请求被拒绝，状态未变。
  - `recoveredWithRaise = true`：`thread/goal/set {threadId, status:'active', tokenBudget: 8291+50000=58291}` 后，set 响应与 readback 均为 `"active"`；额外多等 8s 复核（`post-recover-settle`），`status` 仍 `"active"`，`tokensUsed` 小幅涨到 9656（新预算充裕，未被打回 budgetLimited）。
- **一处需要精确纠正 brief 预判措辞的地方**：brief 把这个机制描述成"不抬预算的拉回会被**静默吞**，只有 readback 能发现"（暗示 set 响应会撒谎说"active"，只有另发一次 get 才能揭穿）。实测更准确的情况是：**set 响应自己就没有撒谎**——`pull-no-raise(set)` 的返回值里 `status` 字段直接就是 `"budgetLimited"`，如实反映了请求被拒绝这件事；不需要额外的 `get` 调用就能发现"没有真的 active"。这比 brief 预判的最坏情形（响应本身不可信、必须靠第二次 RPC 才能拆穿）更安全——**但"必须检查响应/结果里的实际 status、不能假定请求发出即生效"这个原则仍然成立且被坐实**，只是"是否需要一次独立的 `get`"这个具体设计问题上，本次证据支持"检查 set 自身返回值就够"，与 S1b 已有的"3 次跑 set/get 逐行一致、没坐实必须靠 get 才能揭穿"的结论是一致的、互相印证的。建议 spec §4 的措辞从"set 后必须 readback"调整为"必须读取 set 的实际返回状态（而非假定请求即生效）"，更贴合两次 spike 的联合证据。
- **必记**：`turn/start` 响应 (`turnStartRaw`) 落盘在 fixture 里，供排查用；轮询 method 集合与 S2 相同。

## S4：thread/inject_items 注入续跑 diagnostic（Task 5）

- **前置命名坑（brief 需要更正）**：brief 给的方法名是 `thread/inject-items`（连字符），实测 app-server 直接拒绝该 method（`-32600 Invalid request: unknown variant`），错误信息完整枚举了全部合法 method 名，其中确认唯一存在的是 **`thread/inject_items`**（下划线）。这条结论最初来自第一次跑脚本时的原始输出（当时用错方法名撞出来的），但那次运行后来被手动 SIGTERM 中断、没有落 fixture，review round 1 指出这条证词不可复核——已用一次零成本探测（`s4-verify-method-name.mjs`，不调用 `turn/start`、不需要认证、不产生真实 API 消耗）重新坐实并落盘：`fixtures/s4-method-name-probe.json` 里 `wrongMethodResponse.message` 完整保留了这条 -32600 错误信息（枚举约 130 个合法 method，含 `thread/inject_items`），`correctMethodResponse` 额外证实下划线版本本身会走参数校验（空 `items:[]` 返回 `"items must not be empty"`，不是方法名错误）——两点都是从服务端权威错误信息里核实的，不是猜测；后续任何用到这个 RPC 的实现（含 spec 里的 `resumeSpec`）都要用下划线版本。
- **items 形状实测两个候选，只有一个真的生效**：`ThreadInjectItemsParams.items` 的 schema 是 `items: true`（无内部结构约束），描述写"Raw Responses API items to append to the thread's model-visible history"。Candidate A 是 brief 猜测的 `{type:'text', text}`（其实是 `TurnStartParams.input` 用的 `UserInput` 形状，不是 Responses API item）；Candidate B 是从同一份 schema 目录 `RawResponseItemCompletedNotification.json` 里 `ResponseItem.MessageResponseItem` 定义反查出的真实形状 `{type:'message', role:'user', content:[{type:'input_text', text}]}`。两个候选各自在独立 thread 上完整实测（各自独立 codexHome/work，不共用状态）：
  - **Candidate A：RPC 层无 error（`result:{}`），但对模型不可见/不生效**——注入后又完整跑完 2 个 turn（`turnCompletedAfterInject=2`），tokensUsed 涨了 3284，但 `out.txt` 全程未创建，goal 最终状态落到 **`"blocked"`**（S1a/S1b/S2/S2b 都没见过的新状态值，本次未深入排查触发条件，记为待跟进的副产品发现，不影响 S4 本身的判定）。
  - **Candidate B：PASS，强证据**——注入后 `out.txt` 真实创建，内容精确为 `"DONE\n"`（`DIAGNOSTIC` 是本次实验里唯一提过 `out.txt`/`DONE` 的输入源，`turn/start` 首轮输入只说"等待指令、没有指令前不要建文件"，排除巧合触发）。`out.txt` 在 inject 后 10015ms 出现，goal 最终 `status:"complete"`，tokensUsed 涨了 11424。
- **一个不能忽略的时序细节（比"inject 触发工作"这个词面意思更准确）**：两个 trial 的 `preInject` 快照都显示 `turnStartedCount=2`——也就是说，**在 inject 调用发出之前**，goal 因为 S2 已证实的"目标未达成时自动续轮"机制，已经自己起了第二个 turn。Candidate B 成功的那次，`turnStartedAfterInject=0`（inject 之后没有观测到新的 `turn/started` 事件），但 `turnCompletedAfterInject=1`——**inject 的内容是被"追加进了一个已经在自动续轮中、尚未完成的 turn"的上下文里，被这个已在途的 turn 读到并执行的，不是 inject 本身触发了一个全新的 turn**。这意味着 `thread/inject_items` 本身不是一个"驱动执行"的 RPC，它只做"把内容追加进模型可见历史"这一件事；真正让内容被模型看到并处理，靠的是当时 goal 恰好处于活跃续轮状态、有一个即将/正在读取上下文的 turn 存在。**对 `resumeSpec` 实现的直接影响**：如果注入时 goal 已经是 idle/complete/budgetLimited（不再自动续轮），单独调用 `thread/inject_items` 大概率不会被任何人读到——需要和一次显式 `turn/start`（或先把 goal 拉回 `active` 触发自动续轮）配对使用，不能假设"注入了就会被处理"。这一点 brief 没有预判到，是本次最重要的方法论发现。

## S6：sock 访问壁垒——goalRpc controller 独占的物理定级（Task 6）

- **Step 1 硬性阻断，先如实坐实再想替代方案**：brief 要求 `codex app-server daemon start` 起 daemon、从产物定位 control sock。实测在隔离 `CODEX_HOME` 下直接失败：`Error: managed standalone Codex install not found at $CODEX_HOME/packages/standalone/current/codex` ——这条错误信息说明 `daemon` 子系统硬性要求 `curl -fsSL https://chatgpt.com/codex/install.sh | sh` 装的"受管 standalone install"（daemon 靠这套机制自我更新 app-server 二进制）。追查本次实测环境的 `codex`（`~/.local/bin/codex`）实际是桌面应用 Resources 目录下 `codex` 的软链——桌面应用内置的二进制，不是受管 standalone 安装。换到生产 `~/.codex`（不隔离）复测同一条 `daemon version` 查询，同样失败（`failed to connect to .../app-server-control.sock: No such file or directory`），且生产 `~/.codex` 下根本没有 `app-server-daemon/` 目录——证实 ChatGPT 桌面应用走的是完全不同的内部 IPC（`~/.codex/ipc/ipc.sock`），从未经过这套 `daemon` 子系统。这台机器上也没有第二份 standalone 安装可切换（`which -a codex`/`brew`/`pipx` 均未命中）。装一份新的 standalone 版本会永久改变系统状态（新增二进制、可能改 PATH 优先级），超出本次 spike 的可逆范围，未经明确授权不做。**这是本机环境的安装拓扑问题，不是隔离铁律或认证问题——即便换生产 CODEX_HOME 也一样起不来。**
- **替代方案，有明确依据、非随意绕过**：`codex app-server --help` 的 `--listen` 支持 `unix://PATH` 直连模式，不经 `daemon` 的自管理/自更新包装。这是同一个 app-server 二进制、同一套 RPC 协议、同一种 Unix socket 监听机制——sandbox 是否放行 `connect()` 只取决于调用方进程的 seatbelt profile 是否允许连到这个文件系统路径，跟监听端是被 `daemon` 管理还是前台自己起的进程无关（seatbelt 管的是调用方语法权限，不看对端进程身份）。用这个模式自己前台起、自己管生命周期（`SIGTERM` 停，不调用 `daemon stop`），是对"sock 访问壁垒"这个问题的忠实替代。**踩了两个实操坑**：① sock 路径不能直接放在 `/tmp` 根下（报 `socket directory path exists and is not a directory: /tmp`），要深一层子目录；② macOS `AF_UNIX` 的 `sun_path` 长度上限（`SUN_LEN`）比想象中紧，`mktemp -d` 默认给的深路径（`/var/folders/.../T/tmp.XXXXXXXXXX/ch/app-server-control/app-server-control.sock`）直接超限报错，改用字面 `/tmp/s6-sock-XXXXXX/a.sock` 短路径才成功。
- **视角 A（控制器直连）：PASS**——`net.createConnection(sockPath)` 从 host Node 进程直连，`{"connected":true}`，证明替代 sock 本身可用、监听正常。
- **视角 B（`codex exec --sandbox workspace-write` 内连同一 sock）：EXECUTOR_BLOCKED:EPERM**——沙箱内 `node -e` 跑同一段连接代码，`connect()` 直接拿到 `EPERM`。**关键细节，明显加强这个结论的可信度**：`codex exec` 的启动横幅原文写着 `sandbox: workspace-write [workdir, /tmp, $TMPDIR]`——sock 文件所在的 `/tmp` 本身就在这次 sandbox 显式列出的**可写**根目录清单里，执行体理论上完全能看到、甚至能在同目录下写文件。即便如此，`connect()` 依然被拦、报 `EPERM`。这说明挡的不是"文件系统可见性/路径白名单"这一层（那一层反而是放行的），而是 seatbelt profile 里独立的网络/IPC syscall 限制层——`workspace-write` 沙箱对"任意 Unix domain socket 的 `connect()`"这个动作本身有单独的拒绝规则，不看目标文件路径是否在可写区。这比"只是恰好放在沙箱看不到的路径下"这种弱证据强得多，泛化到真实 `app-server-control.sock`（不管它具体落在 `$CODEX_HOME` 下的什么路径）的可信度也更高。
- **诚实的限制**：本次视角 B 测的是替代的前台 `--listen unix://` 进程，不是 `daemon` 管理的真实 `app-server-control.sock`——因为 `daemon` 子系统在这台机器上从 Step 1 起就无法运行，不是没测，是测不了。虽然 EPERM 的证据看起来是 syscall 层的通用限制、大概率会同样适用到真实 daemon sock（两者除了 `daemon` 自管理/自更新包装外，进程身份、RPC 协议、socket 类型完全一致），但没有在装了受管 standalone install 的机器上做过交叉验证，这一点在判定里必须显式带上。
- **判定：BLOCKED（sandbox 挡得住）→ finalize receipt 维持可信**，限定在"本替代实验的证据、未在真实 daemon sock 上交叉验证"这个前提下。

## Spike 结果矩阵

| # | 验证 | 判定 | 证据锚点 | 对实现的影响 |
|---|---|---|---|---|
| Task 1 | app-server stdio 握手（initialize 必需 + thread/start 返回 threadId）+ CODEX_HOME 隔离 | PASS | 本文件「探测脚本实际输出摘录」；`spikes/goal-runtime-adapters-v2/probe-handshake.mjs` 可重跑复现 | `goalRpc` 原型的 `initialize()`/`threadStart()` 已按实测固化进 `appserver-client.mjs`；后续 spike 直接复用该 harness，无需重复探测握手 |
| S1a | 外部设 complete + 可归因 | PASS | `s1a-set-complete.json:setComplete.result.goal`（status=complete，goalKeys 见上）、`getAfter.result.goal.status=complete` | goal_id 在 RPC 层不可得（schema+实测双证）→ finalize 归因改用 `updatedAt+threadId`；但 `updatedAt` 秒级精度，同秒内连续 set 会撞值，归因需另加 status 转移序列或客户端序列号兜底。另：goal 要求非 ephemeral thread，ephemeral 任务无法挂 goal（harness 默认值需按此覆盖）。 |
| S1b | 拉回 active（条件 CASE 半） | PASS（限定 tokens_used=0） | `s1b-pull-active.json:runs[*].cases`（`pull-active-plain`/`pull-active-with-budget` 两个 case，3 次独立跑 `runs[0..2]` 逐行一致，含实测 `tokensUsed` 字段） | PASS→app-server 路径在本测试场景（外部直连 RPC、无实际 turn 执行、CASE 闸守卫 `tokens_used>=token_budget` 因 `tokensUsed` 恒为 0 而未触发）下成立，拉回未被吞。**但与 brief 预判的「二进制 SQL 证据指出会被吞」直接矛盾**，本 spike 只覆盖了空闲 thread 上的外部直连 `thread/goal/set`，没有覆盖「实际 turn 执行中内部状态机自身触发转移、且守卫真正触发」的路径——若吞没现象只发生在后者，本测试测不到，需要额外 spike 才能排除（team lead 已采纳，纳入 S2：设小 `tokenBudget` 逼真实 turn 烧进 `budgetLimited` 再验证拉回/抬预算）。不应仅凭本次 PASS 就断定该风险已消除。 |
| S2 | idle 自动续轮 | PASS | `s2-idle-continuation.json:events`（`turnStartedCount=2`，仅 1 次外部 `turn/start` 调用）；work 目录 `a.txt`/`b.txt` 分两个不同 mtime 生成 | PASS→goal active 且目标未达成时，服务端在 turn 完成后~13ms 内自动链起下一 turn，**不是等一段 idle 时间才恢复**；adapter 端不需要自己实现"检测 idle 后手动续轮"的逻辑，但需要订阅 `turn/started`/`turn/completed`（而非猜测的宽泛正则）来正确计数/呈现 turn 边界，并且要意识到"目标未完成的 goal 一旦起了首轮就会持续自动烧 token 直到完成或撞到预算/时间上限"——无人值守场景下这是设计默认，不是需要额外触发的特性。 |
| S2b | 超预算恢复(生死闸) | 三坐实点均为 true：`reachedBudgetLimited`/`swallowedWithoutRaise`/`recoveredWithRaise` | `s2b-budget-recovery.json:phases`（`poll-3` 转 budgetLimited、`pull-no-raise`/`pull-with-raise` 两组 set+readback） | 坐实 spec §4 的核心诉求（不抬预算的拉回被拒绝、抬预算后能稳定停在 active），但**测得的具体机制比 spec §4 原措辞更安全**：`set` 响应自身就如实返回被拒绝后的真实 status（不是"响应撒谎、只有 get 才能拆穿"），建议 spec §4 措辞从"set 后必须 readback"改为"必须读取 set 返回的实际 status、不能假定请求即生效"——两次独立 spike（S1b 的 15 组 set/get 逐行一致 + 本次 set 自身如实反映拒绝）指向同一结论。另：`tokenBudget:2000` 单轮固定开销（~8000 tokens）就能烧穿，预算设计需以"单轮最低开销"而非"多轮累积"为下限基准。 |
| S4 | inject 续跑 diagnostic | PASS（items 用 candidate B 形状） | `s4-inject.json:trials[1]`（candB：`injectError=false`、`outTxtContent="DONE\n"`、`turnCompletedAfterInject=1`）；对照组 `trials[0]`（candA：无 error 但 `outTxtExistsFinal=false`，goal 落 `"blocked"`）；方法名结论见 `s4-method-name-probe.json`（零成本复核，见下方叙述段） | 方法名实测是 **`thread/inject_items`**（下划线，brief 写的连字符 `thread/inject-items` 直接 -32600 不存在）；items 形状必须是 Responses API 的 `{type:'message', role, content:[{type:'input_text', text}]}`（`ResponseItem.MessageResponseItem`），brief 猜的 `{type:'text',text}`（`UserInput` 形状，实为 `turn/start.input` 专用）RPC 层不报错但对模型无效、最终把 goal 拖进未见过的 `"blocked"` 状态。**关键限制（brief 未预判）**：inject 本身不驱动执行、只把内容追加进模型可见历史；两个 trial 的 `preInject` 都显示 inject 前 goal 已因 S2 证实的自动续轮起了第二个 turn，PASS 的那次是这个已在途的 turn 读到了注入内容（`turnStartedAfterInject=0` 但 `turnCompletedAfterInject=1`），不是 inject 触发了新 turn——若注入时 goal 已经不再自动续轮（idle/complete/budgetLimited），`resumeSpec` 必须额外配一次显式 `turn/start` 才能保证注入内容被读到。 |
| S6 | sock 访问壁垒 | BLOCKED（`EXECUTOR_BLOCKED:EPERM`，限定于替代实验） | `s6-sock-barrier.json`（`step1_daemonStartAttempt.blocked=true`、`controllerView.connected=true`、`executorView.marker="EXECUTOR_BLOCKED:EPERM"`） | `codex app-server daemon start` 在本机无法运行（非受管 standalone install，见叙述段）——真实 `app-server-control.sock` 未能直接测到，改用 `--listen unix://` 前台替代进程（同二进制/同协议/同 socket 机制，只是自管生命周期）。`workspace-write` 沙箱对该 sock 的 `connect()` 直接 `EPERM`，且沙箱横幅显式把 sock 所在的 `/tmp` 列为可写区——说明挡的是 syscall 层的网络/IPC 限制，不是文件路径可见性，这个机制大概率会同样适用到真实 daemon sock。**finalize receipt 维持可信**，spec §5/§8 结论按此更新，但需带 caveat：证据来自替代进程、未在装有受管 standalone install 的机器上做真实 `daemon` sock 交叉验证。 |
| S3 | Stop hook 续轮 + resume 继承（Claude 侧） | PASS | `s3-hook-loop.json` | 生效协议=JSON decision block（非 exit 2）；单次 -p 内闭环「未达标→block→续轮→达标→allow→停」；resume 继承=真但**需显式 --settings**，不带则 hook 完全静默失效（触发计数增量 0）——坐实 KR12 resumeSpec 强制带 settings。⚠️ hook reason 与 objective 语义冲突时模型会遵从 objective 罢工→静默 block 到 max_turns 死循环 |
| S5 | deny 防护面 + Bash 旁路（Claude 侧） | 核心反证 KR3；精确机制 INCONCLUSIVE | `s5-deny-surface.json` | hook 保护比 KR3 预测更强——简单 Bash 重定向（`printf > hook`）也被挡，permission_denials 有 tool_name:Bash 实录；deny 不只挡工具层。语义级路径解析 vs 字面文本匹配未定性（runC/runD 12 次全撞 API 529，待补测）；§7 hook 篡改探针测试必含 Bash 直接重定向用例 |

> S3/S5 两行原产于 Claude 侧独立 lane 的 `2026-08-06-claude-lane-results.md`（worktree spike/claude-lane），Task 9 汇总时并入本主矩阵；该独立文件保留作原始记录。

## 路径判决（据 7 spike 实测）

**Codex 侧 app-server 全量对接：成立。** S1a/S1b/S2/S2b/S4/S6 全部 PASS/坐实——生死闸 S2b 三坐实点全真（超预算→budgetLimited→不抬预算被拒→抬预算恢复到 active），S1b 在 tokens_used=0 下拉回有效、S2b 补上真实 turn 烧超预算的吞没分支；起首轮 `turn/start` 撞开、idle 续轮近瞬时链式（~13ms）；inject 载体 `thread/inject_items` 可用（但不独立驱动执行）；finalize receipt 经 S6 定级为**可信**（sandbox seatbelt syscall 层挡住执行器 connect sock）。**S1b/S2 均未 FAIL，Codex 侧不触发回退 exec——app-server 全量成立。** 唯一 caveat：S6 证据来自 `--listen unix://` 替代进程，未在装受管 standalone install 的机器上对真实 daemon control sock 交叉验证。

**Claude 侧 Stop hook 续轮：成立。** S3 PASS——嵌套 claude -p 可行、JSON decision block 协议生效、单次 -p 内闭环、resume 继承 hook（需显式 --settings）。**S3 未 FAIL，Claude 侧不触发回退裸 -p——Stop hook 续轮成立。** 两个重要 caveat：① hook reason 与 objective 语义冲突时模型会罢工→死循环（spec §5 需处理 hook reason 措辞 + max_turns 耗尽路径）；② S5 反证了 KR3——deny 对简单 Bash 也有效、hook 保护比四源审核假设的强，但精确机制（语义级 vs 字面）INCONCLUSIVE 待补测。

## 对 spec 的折回清单（11 项，供 v1→v2 折回）

1. **§3 D5 finalize 归因**：goal_id RPC 层不可得（S1a 双证）→ 归因改 `updatedAt`+`threadId`；但 updatedAt 秒级、连续 set 撞值 → 需加 status 转移序列或客户端序列号兜底。
2. **§4 set 返回真实 status**（S2b/S1b）：set 响应自身如实返回被拒 status → 措辞从「set 后必须 readback」改「必须读 set 返回的实际 status，不假定请求即生效」。
3. **§4/context ephemeral 约束**（S1a）：goal 必须挂非 ephemeral thread（ephemeral 拒 goal RPC -32600）。
4. **§4 续轮语义**（S2）：goal set 不自动执行，需 `turn/start` 起首轮；续轮近瞬时链式（~13ms）非等 idle 窗口 → 措辞改「目标未达成即自动续轮」；订阅 `turn/started`/`turn/completed` 计数。
5. **§4 预算基准**（S2b）：单轮固定开销 ~8000 tokens，预算下限以「单轮最低开销」为准。
6. **§5 resumeSpec 硬约束**（S4）：inject 不独立驱动执行，goal 不再自动续轮（idle/complete/budgetLimited）时单 inject 没人读 → resumeSpec 必配显式 `turn/start`。inject method=`thread/inject_items`，items=`{type:message,role,content:[{type:input_text,text}]}`。
7. **§5 Claude 续轮 hook reason**（S3）：hook reason 与 objective 冲突致模型罢工死循环 → spec 需规范 hook reason 措辞（不与 objective 冲突）+ max_turns 耗尽的处理。
8. **§5 resume 必带 settings**（S3，坐实 KR12）：resumeSpec 强制复用 --settings，不带则 hook 静默失效。
9. **§5/§8 KR3 方向性反证**（S5）：deny 对简单 Bash 也有效 → hook 保护定性从「观测性防线、非物理」改「比 KR3 强、对简单 Bash 重定向有效；精确上限（语义级 vs 字面）INCONCLUSIVE 待补测」；§7 hook 篡改探针测试必含 Bash 直接重定向用例。
10. **§5/§8 S6 receipt 可信带 caveat**（S6）：sandbox seatbelt syscall 层挡住执行器 connect sock → finalize receipt 可信；caveat：证据来自替代进程，未在真实 daemon sock 交叉验证。
11. **auth-copy 安全模式**（Task 4/5）：真实 turn 需认证 → 隔离 CODEX_HOME 只读复制生产 auth.json，独立 mkdtemp（codexHome 与 work 不共父）+ finally + SIGTERM/SIGINT 信号兜底清理。实现阶段 launch.mjs 的 auth 处理须遵此模式。

## 对 Plan 2（实现阶段）的输入

路径判决与折回清单已定：Codex 走 app-server 全量、Claude 走 Stop hook，两条都不回退。实现阶段 launch.mjs / adapters / goalRpc / hook 生成器按上述实测形状落地——`turn/start` 起首轮、`thread/inject_items` + message item 形状、JSON decision block hook 协议、resume 带 settings、auth-copy 安全模式；normalizeTerminal 的 Codex 事件源用 `turn/started`/`turn/completed` + goal status 事件；finalize 归因用 updatedAt+threadId+序列号（非 goal_id）。
