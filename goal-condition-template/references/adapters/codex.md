# Codex adapter

此 adapter 只处理 `runtime="codex"` 的已确认 run contract。字段语义、hash 与 snapshot 握手见 [run-contract reference](../run-contract.md)。它描述调用边界；本文与测试不调用任何真实 goal tool 或真实 daemon。

## GoalSession v2 受控执行面

GoalSession v2 是 Codex-only 的独立 controller 包；Claude adapter、共享 v1 schema 与共享状态机语义不变。它把生命周期不同的对象拆开：Goal 与 Non-goals 在整个 session 内稳定；Maximum Authority、Hard Prohibitions、最大风险和预算由用户授权；Active Boundary 与 ConditionSet 形成可演化的 Design Revision；每次 Attempt 则是不可变投影。独立是权限边界，不是再找一个 LLM 审批。

用户确认的是 `authorization_hash = hash(goal_hash, authority_revision_hash)`。初始 `presented_design_hash` 只进入 ConfirmationReceipt 供审计，不把初始设计冻结成授权对象。Condition 使用稳定 ID，定义内不保存 `satisfied`；是否满足只由绑定 verifier 版本、输入哈希、Attempt、结果与期限的 controller-owned Evidence 决定。root baseline 全 session 唯一，Attempt 只能另取增量 snapshot，不能用新 baseline 洗掉历史 mutation。

自动调整只接受封闭的 typed operation，不能采信执行器写出的 `monotonic=true`：

| 分类 | 决策 |
|---|---|
| `ADD_CONDITION`、`ADD_AND_VERIFIER`、`TIGHTEN_TYPED_THRESHOLD` | Authority 内且结构证明成立时自动 |
| `NARROW_ACTIVE_BOUNDARY`、`EXPAND_WITHIN_AUTHORITY` | 包络内自动；越界转再授权 |
| `REFRESH_CONTEXT` | controller 实读 bytes/当前 hash 后局部失效 Evidence |
| `CONTROLLER_CORRECTION`、`REPLACE_EQUIVALENT_VERIFIER` | 独立 correction/parity proof API 未实现前 fail closed |
| `EXPAND_AUTHORITY` | 追加 AuthorityRevision、生成新 hash 后 `AwaitingReauthorization` |
| `WEAKEN_CONDITION` | successor GoalSession（authorization hash 不覆盖 Design） |
| `CHANGE_GOAL` | successor GoalSession |
| `UNCLASSIFIED` | fail closed |

Contract Compiler 只编译结构化任务、上下文事实与保守默认值，不进行开放式访谈。只有缺失或矛盾字段会产生两种实质不同结果、且不存在更保守默认时，才返回一个 blocking `CompilationGap`。Brainstorm/Grill 是设计阶段压力测试方法，绝不是每次运行必经的提问、访谈或换名后的 mandatory checklist。

Attempt projector 保持 v1 只读：原生 Codex objective 只承载短而稳定的 Goal，完整 Boundary、Conditions、content-bound Context、Non-goals 与 Hard Prohibitions 放入 hash-bound Context Package；Context dependency 的 stable path 必须位于 Active Boundary 内，并在首次授权预览显示 path/content hash。Projection Proof 必须为每个 Active Condition 给出 v1 contract 位置、运行时 context pointer、verifier 与 Evidence 依赖。任何漏映射都阻止投影。

完成等级分三层：executor/runtime 输出只能形成 `Candidate`；当前 controller-owned Evidence 全部有效可到 `Verified`；没有 control-plane bypass、unmediated turn 或未对账变化时才可 `Certified`。reviewer 文字、executor 的 all-green 或模型自报都不能直接认证完成。

GoalSession v2 controller 通过 `capabilities`、`adopt`、`init`、`preview`、`confirm`、`prepare`、`launch`、`verify`、`revise`、`resume`、`finalize`、`reconcile`、`close`、`mode` 暴露闭世界控制面。`resume` 在 GoalSession 层创建新的不可变 Attempt；它不复用已经被拒绝的 candidate，也不修改共享 v1 schema。

controller 不复制 app-server 执行器：live 副作用仍只经本 adapter 的 `runCodexLaunch` / `runCodexFinalize` / `runCodexClose`。v2 在同一写事务检查租约并保存 LaunchIntent；LaunchIntent 绑定当前 controller release digest 与 target root 的 canonical path/device/inode，dispatch 时在一个事务内原子 claim `dispatching` 与 Session `Dispatching`，重核版本及物理身份后才调用 launcher。LaunchReceipt 只授权 controller 发出的 `turn/start` 响应 ID；首次、后续以及 finalize 前后的 `thread/read(includeTurns=true)` 出现其他 ID 都是旁路。claim 后读回不明不重发，转 `ReconciliationRequired`。完整命令与状态顺序见 [GoalSession v2 操作协议](../codex-goal-session-v2.md)。

同一稳定 Goal 内遇到 context refresh、增加/加强 Condition 或 Authority 内边界调整时，controller 应应用 typed Design Revision、局部失效 Evidence，并创建新 Attempt；不再回到 v1 的完整 Preview/Confirm。等价 verifier 替换属于同一目标生命周期，但在独立 parity/mutation proof API 落地前保持 fail closed。只有 Authority、风险/预算或 Goal 语义变化才重新授权或建立 successor。

## Launch 前置条件

只有 canonical contract 文件通过 byte-identical 检查、Validate 通过、包含 authoritative canonical JSON 的完整 Preview 已展示、用户明确确认当前 confirmed hash、Preflight 全绿，并且 `baseline_digest` 已保存到 baseline 文件之外的可信编排状态后，才允许控制器经 `thread/goal/set` 创建 goal。主会话必须先建立下文所示的 controller-owned `runBinding`，再提交同一 binding 的 closed-world `preflightEvidence={ok,reasons,binding}`；它不能来自执行会话输出。缺项、失败或 cross-binding 都停止 launch。用户说“直接跑”不替代 hash 确认。

```json
{
  "contractHash": "<confirmed contract hash>",
  "baselineDigest": "<trusted baseline digest>",
  "runId": "<controller-issued run id>"
}
```

goal 由控制器创建，不是模型的 `create_goal`：objective 文本必须明令禁止模型调用 `create_goal`，并内联关键 judgment criteria、success criteria、constraints 与 allowed mutations，不得把第二个目标塞进 objective。原生“一个 thread 已有未完成 goal 时 create 失败”提供了额外护栏，但不能替代 objective 层面的显式禁令。

只有用户明确提供 token 上限且 contract 含 `budget.user_provided=true` 与 `budget.max_tokens` 时，才把该值映射为 `thread/goal/set` 的 `tokenBudget` 参数；没有明确用户来源时必须省略。GoalSession Authority 的 `maximum_budget:null` 同样表示未授予预算，不是无限预算；首次授予有限值要产生新 authorization hash，已有有限授权不能靠改回 null 删除。turn、时间或费用限制若不是原生参数，只作为监控条件，不冒充 tool 字段。

无法在当前 Codex 环境物理限制的外部动作必须标为 `audit_only`。如果用户要求 physical 保证，应在只读凭证、proxy、sandbox 或可验证 deny mechanism 就绪前停止 launch。本 adapter 侧唯一可核的物理面是 `thread/start` 的 `--sandbox`：legacy v1 固定 `workspace-write`；GoalSession v2 从 Active Boundary 投影，actions 不含 `write` 时必须是 `read-only`，包含 `write` 才允许 `workspace-write`。launch 前置闸逐条比对 `enforcement="physical"` 的 constraint，`mechanism` 指向 sandbox 但与实际模式不符即红，`mechanism` 指不到 sandbox（egress proxy、只读凭证等）或干脆缺失同样红——那些机制运行在 controller 视野之外，无从验证，只能写成 `audit_only`。

legacy v1 的两条路径必须分开读：`launch` 靠**请求参数**（`thread/start` 显式传 `sandbox`）；底层 `runCodexResume` 只传 `{threadId}`，沙箱从持久化 thread 恢复，只能读回来核——见下文 resume 小节第 0 步。同一个 workspace-write 模式在协议两侧是两个词形：请求参数写 `workspace-write`，响应体写 `workspaceWrite`。GoalSession v2 的 `resume` 不走这条可变 continuation；它建立新的 immutable Attempt 和 thread/start，因此每次都重新投影 `read-only | workspace-write`。

## 姿态：app-server 是外部编排的唯一表面

外部编排唯一表面是 app-server JSON-RPC：`thread/goal/set`（params `{threadId, objective?, status?, tokenBudget?}`）、`thread/goal/get`、`thread/goal/clear`，以及通知 `thread/goal/updated`/`thread/goal/cleared`。`create_goal`、`get_goal`、`update_goal` 是线程内**模型侧 tool**——外部编排对它们没有调用通道，控制器一律走对应 RPC 方法代替：创建用 `thread/goal/set`、查询用 `thread/goal/get`、清理用 `thread/goal/clear`。

反例：执行器在 turn 内自行调用 `update_goal` 把状态标为 complete，不构成 finalize（见下文“finalize 归因”）；主会话把这类模型侧自报当作 controller evidence 直接采信，是需要被拒绝的错误实现。

## 生命周期：daemon、租约与首轮

controller 用 stdio 直连 codex `app-server` daemon、持有其生命周期；启动即写租约（controller 心跳 + TTL）。租约的作用面只有一个：阻止下一次并发 launch。它不是 watchdog——daemon 不知道租约存在，TTL 到期不会有任何一侧去 clear goal。因此租约有两种残留形态，launch 前置闸都拦：心跳仍在 TTL 内是「上一次 launch 还活着」，超出 TTL 是「持有者已失联，但它起的 daemon 与 active goal 可能都还在」，后者的出口是先跑 `close`（clear goal + 删隔离 `CODEX_HOME`），不是直接重跑 launch。

controller 被 SIGKILL 时孤儿 daemon 的归宿：app-server 走 stdio，父进程死后 stdin EOF 很可能让它自退，但这一点未经实测，实现也不依赖它——「不出现两个并发执行器」这条保证来自上面的 launch 前置闸，不来自 daemon 自退。

`thread/start` 必须显式传 `ephemeral:false`——goal 必须挂在非 ephemeral 的 thread 上，实测 ephemeral thread 上发起 goal RPC 会被拒绝（`-32600`）。thread 就绪后由控制器调用 `thread/goal/set` 创建 goal；goal set 本身不驱动执行，必须紧接着显式调用 `turn/start {threadId, input:[{type:'text', text}]}` 才能推入真实 turn。

运行期间订阅 `turn/started` 与 `turn/completed` 计 turn 边界：只要 goal 尚未达成，服务端会在一个 turn 完成后约 13ms 内自动链起下一个 turn——这是近瞬时链式，不是等 idle 窗口，adapter 不需要自实现 idle 检测。控制器额外轮询 `thread/goal/get`，配一个 wall-clock deadline（adapter 常量）；超时即终局报告。

两个 turn 计数落在 `turn-counts.json`，它们是**控制器观察到的通知数**，不是服务端的权威 turn 记账：控制器拿到判定的那一拍就停止观察，此刻还在飞的 turn 只记进 `started`。goal 的 `complete` 由模型在 turn 内自标，控制器看得见它**严格早于**那个 turn 结束，所以成功路径上 `completed = started - 1` 是必然而不是漏记。这句口径写在文件自身的 `semantics` 字段里——它是操作员判断「跑了几轮」的唯一依据，字面上的「差一」不解释就会被读成「最后一轮没跑完」。

服务端对同一个 turn 的说法更强：thread 历史里它是 `status:"interrupted"`（控制器拿到判定后就把 app-server 停了，那个 turn 在服务端一侧同样没跑完）。两份记录都准确、说的是同一个正常收尾，但必须放在一起读——只看一边会把「`turn-counts.json` 说它 started 过、thread 历史说它 interrupted」当成矛盾。`semantics` 字段里也写了这半句。

## 跑飞护栏：执行面坏掉时的终局来源

wall-clock deadline 之外还有两条 adapter 常量：`MAX_TURNS_PER_ATTEMPT` 与 `MAX_TOKENS_PER_ATTEMPT`，与 `WALL_CLOCK_DEADLINE_MS`、`MAX_AUTO_RESUMES` 同类。它们是**跑飞护栏，不是 contract 预算**：不写进 contract、不由用户提供，与「预算仅用户明给」那条规则不冲突——那条管的是会改变执行体行为的 `tokenBudget`，这两条只决定控制器什么时候停止等待。

起因是实测形态：执行面坏掉（工具调用全部失败）之后，服务端的自动链式续轮会把一个必然失败的 turn 一直重复下去，goal 停在 `active`、target root 分毫未动，而 turn 与 token 一路涨。此时 30 分钟的 wall clock 几乎不构成保护——按实测节奏跑满会是 100+ 个 turn、数百万 tokens。无人值守场景下这是实打实的成本敞口。

- 信号只取控制器已经拿到的两样：轮询回来的 goal envelope 的 `tokensUsed`，以及已订阅的 `turn/started` 计数。**不解析执行体输出**——那会撕开信任模型（执行体产出的内容不得成为控制器判据），护栏属资源层，不属证据通道。
- 刻意**不做**「连续 N 轮无文件变更即熔断」：合法任务可能连着几轮只读不写，误杀真活的代价比多烧一点 token 更高。
- 两条都按**本次 attempt** 计，与 deadline 同口径。两个信号都是跨 attempt 累计量，因此各自扣掉进入本 attempt 时的基线——不扣的话一次合法 resume 会在刚连上时就被误杀。
- contract 给了 `budget.max_turns` / `budget.max_tokens` 时取**更紧**的一侧。反过来 contract 抬不高护栏：那等于让一份 contract 关掉自己的刹车。
- **护栏与 contract 预算不是同一个口径，别把护栏读成在执行 contract 预算。** `budget.max_tokens` 交给服务端当 `tokenBudget`，那是**整个 run 的累计**预算，由服务端自己兜（耗尽即 `budgetLimited`）；护栏量的是**本 attempt 的增量**。所以护栏借用这个数当上限时只是「顺手取一个不会比用户意图更松的值」，不代表它在替 contract 记账——3 个 attempt 各自放行一份 `max_tokens` 是可能的，真正把累计量兜住的是服务端那一侧。
- `resume` 的 `--raise-token-budget N` 是**用户明确确认要抬预算**的载体，token 护栏认它并取代 contract 里那个已被它抬过的旧值，但仍不超过 adapter 常量。不认的话，操作员按文档抬完预算后护栏还按旧值掐，而 reason 会把他指向唯一帮不上忙的那根杆子——他刚拉过正确的那根；本该读到的 `budgetLimited` 成因也会被换成「先查执行面是否健康」，而唯一出路是改 contract，改 contract 换 hash 换 state 目录，thread 就丢了。
- 触顶即**终局报告，不是候选**。reason 自证是护栏触发、带上观测值（本 attempt 的 turn 数与 token 数、累计计数、`tokensUsed`）、并给出下一步：先查执行面是否健康。
- 护栏在「本拍判定不终局」**之后**才评估：目标已经达成时不该被护栏改判，活干完了就是干完了，与它烧了多少无关。

通知除了计数还要**留痕**：终局状态词自己不解释自己（`usageLimited` 只是服务端给的一个字符串），而成因只在通知里，`close` 又会把隔离 `CODEX_HOME` 连同 rollout 日志一起删掉——按正常流程（撞限流 → 报告 → `close` 收尾）操作，成因就永久丢失。因此 `account/rateLimits/updated`（限流成因：credits 余额与重置时间）与**带 `error` 体的** `turn/completed` 会以 `direction:"notification"` 追加进 `rpc-envelopes.jsonl`，并进入终局报告的 `reasons`。其余通知不落盘：`item/agentMessage/delta` 逐 token 触发、`turn/diff/updated` 携带工作树 diff 全文，它们是执行体产出的**内容**而非控制器判定所需的事实，落盘既撑爆日志也把执行体内容写进了证据通道。落盘的 payload 一律序列化后截断到一个固定上限。

## 状态写入语义与六态处置表

`thread/goal/set` 的状态写入不是无条件直写：底层 UPDATE 经条件 CASE——当前状态落在某个预设集合内时，写入保留当前态、忽略这次请求（粘滞分支）；另有预算分支，请求 `active` 时若 `tokens_used` 已 ≥ `token_budget`，会被服务端悄悄改写成 `budgetLimited`。RPC 返回成功不代表状态已按请求改变：调用方必须读取 set 响应本身返回的实际 status，不假定请求即生效（S2b 与 S1b 的联合证据口径——S2b 证实 set 响应自身就如实反映被拒绝的结果，不必额外发 get 才能拆穿）。sqlite 记账层使用的字段是 snake_case（如 `token_budget`），RPC 层实测词形是 camelCase（`tokenBudget`、`budgetLimited` 等）；本文档统一使用 RPC 层词形，仅在指代底层记账时保留 `token_budget` 这个写法。

| goal 状态 | 处置 |
|---|---|
| `active` | 正常轮询；超 wall-clock deadline，或 turn/token 跑飞护栏触顶 → 终局报告 |
| `complete` | 不可信候选 → 控制器独立 postflight |
| `blocked` | 终局报告（阻断证据 + 下一步），不进验收、不 finalize。**这条路径只在工具面健康时可达**——自标 `blocked` 走的 `update_goal` 与被阻断的执行通道共用同一条实现，工具面一坏它跟着坏，goal 会一直停在 `active`。那种情形下的终局来源是控制器侧的护栏，不是这一格（见「blocked 终局」）|
| `paused` | 终局报告并停机，**不自动 resume** |
| `usageLimited` | 终局报告并停机，**不自动 resume**——自动 resume 等于绕过限流，触发「无人值守禁旁路」铁律 |
| `budgetLimited` | 终局报告并停机；续跑抬预算须经用户确认（预算仅用户明给），预算下限以单轮最低固定开销（约 8000 tokens）为基准，不是多轮累积 |

执行体自标 `complete` 后，adapter 把这个 goal 事件归一化为提交给公共状态机的 `untrusted runtimeResult`，其形状只能是这个 exact candidate：

```json
{
  "status": "ready_for_postflight",
  "remaining_work": false
}
```

这个形状里**没有 attempt 身份**，两个 attempt 产出的因此是同一串字节——「手里这份 candidate 出自哪一轮」在协议层判不出来。形状不能改（它是公共状态机的闭世界契约，改动跨版本影响所有 runtime），所以身份由控制器侧绑定：每次产出候选都按 attempt 号归档一份 `attempts/<n>-candidate.json`，`finalize` 在起 client 之前先核**最近一次 attempt 自己产没产出候选**，没有即拒（两份证据文件照常写成 `ok:false`）。

这条纪律堵的是它与「终局后 `nextAction` 仍说 launch」合流之后的形态：续跑以终局报告收场（护栏触顶、`budgetLimited`、六态停机），编排器手里还攥着首发那份 candidate，只要此刻 postflight 恰好转绿（执行体在被掐断之前把活干完了是完全可能的），这条链就能一路推到 `finalize`——而 `finalize` 自己 set complete 再读回，`runtimeReadback` 也照不出「执行体是被中断的」。编排器侧对应的纪律是一句话：**上一次 attempt 的 candidate 不得配这一次的 postflight**；`attempts/<n>-candidate.json` 是判断它的磁盘依据，`candidate.json` 只是「最近一次候选」，续跑以终局报告收场时它仍是上一轮那份。

归档的不是裸 candidate 而是一份**控制器信封** `{attempt, binding, candidate, threadId}`：协议对象是喂给 `nextAction` 的那个 `runtimeResult`，归档文件是控制器自己的产物，可以带控制器自己的事实。`finalize` 核的是信封的内容而不是「文件在不在」——形状闭世界、`attempt` 号与文件名自洽、`candidate` 仍是合法终态、`binding` 三元组与本次 finalize 的 binding 逐字相同。只判存在的话，一个零字节文件、或把上一轮那份改个名顶上，都能放行。这道核验的前提同样是上文那条：state 目录在执行体可写面之外。

## resume：状态拉回、注入与显式续轮

postflight 红且属于可续类时，控制器发起续跑。重新连接既有 thread 时先调用 `thread/resume {threadId}`（区别于新建 thread 的 `thread/start`），随后按以下四步顺序执行：

0. **核 `thread/resume` 的返回体**，再决定要不要往下发第一个 op。那个返回体不是空壳：实测它装着整个会话配置（`thread`、`model`、`cwd`、`runtimeWorkspaceRoots`、`approvalPolicy`、`sandbox`、`activePermissionProfile` 等），而它是续跑路径上**唯一的物理面观测**。必须核三项加一项身份：`sandbox` 块整块等于 launch profile、`cwd` 等于 contract 的目标根、`runtimeWorkspaceRoots` 每一项都落在 contract 的 `target_roots` 内、`thread.id` 就是本次要续的那个 thread。任一不符即终局报告，且必须落在 `thread/goal/set` 之前——核验发生在执行体起跑之后就来不及了。字段缺失同样红：协议漂移掉了这几个字段时，「核不了」不等于「核过了」。

   沙箱比的是**整块**，不是 `type` 一个字段：`{type, writableRoots, networkAccess, excludeTmpdirEnvVar, excludeSlashTmp}` 五格逐字对齐 `thread/start` 产出的 profile，多一个未知字段也红。同 `type` 而 `writableRoots` 多出一项或 `networkAccess` 翻真的沙箱照样是另一个沙箱，而 resume 侧控制器什么都没设、什么都不知道，只读一个字段等于把其余四个交给信任。两个 `exclude*` 钉的是**连续性**不是「要求这两处可写」——与 launch profile 不一致的续跑，无论松紧都不是同一个沙箱。沙箱块将来多一个旋钮时这道闸会红，那正是要人看一眼的时刻：新旋钮的语义只有人能判。
   **不核** `approvalPolicy` 与 `activePermissionProfile`：实测它们在 start/resume 之间本来就不逐字相等（`activePermissionProfile` 从 `null` 变成 `{"id":":workspace","extends":null}`），拿它们当判据会把一次正常续跑判红。路径比较前两侧都要归一（symlink 的两侧是同一个目录的两种写法）。

1. `thread/goal/set {threadId, status:'active'[, tokenBudget]}` 把状态拉回 `active`；预算已耗尽（`budgetLimited`）时同一请求可以带上抬高后的 `tokenBudget`。
2. 读取该 set 响应本身返回的 status，确认确实等于 `active`——不必额外调用 `thread/goal/get` 做二次 readback。
3. `thread/inject_items {threadId, items:[{type:'message', role:'user', content:[{type:'input_text', text}]}]}` 把红项 diagnostic 追加进模型可见历史，随后显式调用 `turn/start` 推入真实 turn。

S4 实测：`thread/inject_items` 本身不驱动执行，只把内容追加进模型可见历史；若 goal 已不再自动续轮（idle、complete 或 `budgetLimited`），注入内容不会被主动读到，必须配显式 `turn/start` 才能让内容真正被处理。

## finalize 归因

控制器提交 candidate 后，状态机只会请求 `postflight`。主会话独立重跑结构化 verifier，并对照原始 `baseline_digest` 做 snapshot verify；全绿后提交与 `runBinding` 相同的 `postflightEvidence={ok,reasons,binding}`。只有 postflight 全绿且没有 remaining work，`nextAction` 才返回 `finalize_runtime`。

收到该 action 后，GoalSession v2 先以 `thread/read(includeTurns=true)` 核 LaunchReceipt 的 exact turn set；任何缺失、重复或额外 turn 都在 terminal mutation 前 fail closed。通过后，主会话调用 `thread/goal/set {threadId, status:'complete'}`——不是 `update_goal`：控制器对这个模型侧 tool 没有调用通道。即使模型此前已自行调用 `update_goal` 把状态写成 `complete`，也不构成 finalize。注意这里的机制**不是** no-op：实测服务端对同状态写入照样刷新 `updatedAt`（goal 已是 `complete` 时再 set 一次，`updatedAt` 从 `1786257720` 推进到 `1786257793`），所以控制器的 set 虽然在状态维度是同值写入，仍会在 envelope 上留下一个新的时间戳，归因因此比“完全无痕”要强。但这不足以单独承载 finalize：RPC 层拿不到 goal_id，`updatedAt` 又是秒级精度、同一秒内两次 set 会撞值。finalize 证据必须来自控制器自己发起的 set 与随后的 readback 绑定，并叠加下文的单调序列号，不能只看“状态已经是 complete”这件事本身。

`ThreadGoal` envelope 在 RPC 层不含 `goal_id`/`goalId`（schema 与实测 `Object.keys` 都只有 `threadId`/`objective`/`status`/`tokenBudget`/`tokensUsed`/`timeUsedSeconds`/`createdAt`/`updatedAt`），归因因此改绑三项：`threadId` 一致、两侧 status 均为 `complete`、readback 的 `updatedAt` 等于 set 响应的 `updatedAt`。`updatedAt` 是秒级精度，同一秒内连续两次 set 会撞值，所以必须再叠加控制器侧维护的 goal-set 单调序列号（每次 set 递增记账，finalize 时核对最后一条记录的序列号与 requestedStatus）才能构成严格归因。

成功调用产生独立的 `finalizationReceipt`，不得由 `runtimeResult` 代替：

```json
{
  "ok": true,
  "operation": "thread/goal/set",
  "status": "complete",
  "reasons": [],
  "binding": { "contractHash": "<hash>", "baselineDigest": "<digest>", "runId": "<run>" }
}
```

状态机随后返回独立的 `verify_runtime` action。此时主会话调用 `thread/goal/get`——不是 `get_goal`，同样是模型侧 tool、外部编排没有调用通道——把返回的 envelope 保守归一化为 `runtimeReadback`：

```json
{
  "ok": true,
  "source": "thread/goal/get",
  "status": "complete",
  "remaining_work": false,
  "error": false,
  "blocked": false,
  "reasons": [],
  "binding": { "contractHash": "<hash>", "baselineDigest": "<digest>", "runId": "<run>" }
}
```

goal-set/get 后，GoalSession v2 再执行一次 exact turn fence，防止 verify 与 finalize 或 terminal mutation 期间出现未收据 turn。只有前后 fence、candidate、`postflightEvidence`、`finalizationReceipt` 与 `runtimeReadback` 全部存在、顺序正确且 binding 相同，状态机才返回 `complete` 并允许 Close。缺 receipt、额外 turn、set 失败、get error/permission failure、blocked、仍有工作、cross-binding 或未知字段都 fail closed。

## attempt 配额口径

attempt 配额（一次逻辑 run = 1 首发 + 最多 2 次续跑）只统计真的连上了 daemon 的轮次：占号发生在 `start` / `initialize` 成功之后、首个 RPC 之前。在那之前失败的 `launch`/`resume` 一格都不占，改正之后配额仍是满的，包括两类——

- 被 launch 前置闸挡下：残留租约、binding 对不上、沙箱声明不符、`codex --version` 没采集到版本、读不回 thread 坐标；
- 过了前置闸但连接阶段失败：`auth.json` 不存在（操作员没登录 codex）、codex 二进制缺失、daemon 起不来。这三种情形的 reason 会明确写出「失败发生在连接阶段，执行器一次都没被启动，工作目录未被触碰」，**不会**要求跑 snapshot verify。

这不是宽松，而是让计数器只统计它声称统计的东西——占号不可撤销、`close` 不清 `attempts/`，而上述原因几乎都在 contract 之外，改正它们不改 contract hash，也就不换 state 目录；占在前面意味着三次笔误或三次没登录就把这份 contract 在这个 state 目录上永久锁死。反过来，一旦连上 daemon 就照常占号，reason 也保留「执行器可能已改仓，须跑 snapshot verify」。注意这条措辞对占号到 `turn/start` 之间那一小段（`thread/start`、`thread/goal/set` 两个 RPC）是**保守而非精确**的：那里还没有任何 turn 跑过，仓库确实没被碰；`turn/start` 之后的失败才是确实可能已改仓。方向是 fail-closed（多要一次核对），不区分是刻意的。

连接阶段失败还会把本次 `mkdtemp` 出来、从未连上过的 codexHome 整个删掉（它按定义是空的：没有 thread、没有 goal，凭证副本已由 cleanup 删除），并且**不写** `codex-home.path`。这两件事合起来保证 state 目录里的 codexHome 指针与 `thread.json` 始终自洽——指针只在 `thread/start` 成功那一刻与 `thread.json` 一同更新。「cleanup 不删 codexHome」那条铁律保护的是**连上过**的 codexHome（thread/goal 状态要跨 attempt 存活），从未连上的不在保护范围。

配额真用尽时诊断 `ATTEMPT_LIMIT_EXCEEDED` 会给出出路：换一个 `--controller` 名重跑 `prepare`（写出带全新配额的 state 目录），或在确认没有 run 在跑之后手工删掉那个 `attempts/` 目录。该判定在复制凭证、启动 daemon 之前就做掉，因此配额已满的 `launch` 是零副作用的 exit 1。并发下另有 `ATTEMPT_SLOT_TAKEN`：两个进程同时对同一个 state 目录起 run 时，O_EXCL 的败者拿到它，出路是确认没有 run 在跑后重试，或换一个 `--controller` 名。两条都是进程级失败（exit 1），不是终局报告。

第三类被拦下的 `launch` 是**残留租约**：上一次运行留下了 `lease.json`。它的出路是跑 `close`——`close` 释放本 state 目录里的残留租约，**不要求 `codex-home.path` 还在**（租约与隔离 `CODEX_HOME` 是两件独立的残留，前者可能在后者写盘之前就已落地）。

`close` 唯一不动的是**持有者还活着**的租约：那是并发互斥原语本身，删掉它就等于放第二个执行器进同一个 target root。判据有两条，命中任一即视为活着：心跳仍在 TTL 内，**或者**租约里记的持有者 pid 仍然存在。第二条不是冗余——心跳只在轮询每拍与连接阶段各刷一次，两次刷新之间最长可达一个轮询间隔加上一次 rpc 的超时上限（60s），**远超**租约 TTL（30s）；只看心跳会把一个正活着、只是卡在慢 rpc 上的 run 判成残留。反过来，pid 被回收时这条判据只会**多保留**一份本该删的租约，方向 fail-closed。

因此跑完 `close` 租约仍在，就说明持有者确实还在，返回体会如实说明它留在了原地并给出 pid：确认那个进程真的结束、或换一个 `--controller` 名重开。返回体的 `leaseReleased` 是这一格的机器可读判据。

## launcher 退出码语义

`scripts/launch.mjs` 的退出码只是给编排器的粗信号；**成败的权威判据永远是 stdout 的报告体**（`outcome` 与 `reasons`）。四格互不重叠：

| 退出码 | 含义 | stdout |
|---|---|---|
| 0 | 命令跑完并产出它声明的结果；`launch`/`resume` 特指 `outcome="candidate"` | 报告体 JSON |
| 1 | 进程级失败：contract / prompt / diagnostics 文件读不出**或红项清单不合形状**、attempt 号没占上（配额已耗尽 `ATTEMPT_LIMIT_EXCEEDED`，或并发下被别的进程抢先 `ATTEMPT_SLOT_TAKEN`）、flag 落在不支持的 runtime 上 | 空（诊断在 stderr） |
| 2 | usage 错误：未知子命令、缺必填 flag、重复或无值 flag | 空（usage 在 stderr） |
| 3 | `launch`/`resume` 返回 `outcome="terminal_report"`：被前置闸挡下没起飞（残留租约、binding 对不上、沙箱声明不符、版本没采集到）、连接阶段失败（凭证复制 / app-server 启动 / initialize），或起飞后判定终局 | 完整报告体 JSON，`reasons` 非空 |

3 与 0 分开是刻意的：二者此前同为 0，「根本没起飞」因此对只读退出码的编排器完全不可见。读退出码判成败的编排器至少要能 fail closed；但它仍不能替代把 `runtimeResult` 原样喂给 `nextAction` 这一步——终局报告不是候选，只有状态机能给出下一步。这里的 `runtimeResult` 指报告体里的 `candidate` 字段，**不是报告体本身**：整个报告体喂进去会被拒（实测收到 `status is required`、`remaining_work is required`、`contains an unknown field` 一串），照字面理解「原样」就会踩这一脚。

exit 3 里那三类必须分开读：**只有连接阶段失败这一类可以断言工作目录没被碰过**（判据是 `reasons` 里写明「执行器一次都没被启动，工作目录未被触碰」）；被前置闸挡下同样没起飞；而「起飞后判定终局」按可能已改仓处理。codex 侧的返回体**没有** `attemptNumber` 字段，不要拿 claude 侧那个判别式（`attemptNumber === null` 即从未起飞）来套。

`finalize` 的判定**不由退出码承载**：权威是它写出的 `finalization-receipt.json` 与 `runtime-readback.json` 里的 `ok`。归因不成立时两份文件都写成 fail-closed 的 `ok:false`（证据存在但为假，比缺文件更能让 `nextAction` 拒得干净），进程同时 exit 3——与 `launch`/`resume` 的终局报告同一格。退出码仍只是粗信号：拿到 3 必须去读那两份文件的 `ok`，而不是据此推断发生了什么。

上表之外还有一格：进程**死于信号**（操作员 Ctrl-C 或 `kill`）。它不是一个自造的退出码，shell 看到的是 130/143 这类 `128+signum`，父进程看到的是「died by signal」。编排器不必给它专门的分支——它落在四格之外，本来就只能 fail-closed。

`close` 同样不由退出码承载：判据是 stdout 的 `cleanupComplete`、`runtimeQuiesced`、`reasons`、`goalCleared` 与 `leaseReleased`。三个资源字段分别管活 goal、隔离 `CODEX_HOME` 与 runtime 租约，但 controller 只有在 `cleanupComplete=true` 且 `runtimeQuiesced=true` 时才能释放自己的 target-root lease。读不到 `codex-home.path` 时仍会独立检查 residual lease；foreign live lease 必须返回未静默、保留 controller lease 并进入 `ReconciliationRequired`，不能让新 Attempt 与旧 runtime 重叠。只读退出码仍不够，编排器必须读完整 JSON。

`snapshot.mjs` 的 `verify` 判否时同样把完整报告体打到 stdout、但 `exitCode` 走的是 1，与上表把「完整报告体」钉在 3、把 1 定义成「stdout 空」不是同一套约定——上表已显式限定 `scripts/launch.mjs`，跨脚本编排退出码时不要混用。

## 信任边界

信任边界必须由调用方实现：`nextAction` 是纯函数，只能验证 closed-world 形状、顺序和 binding 一致性，不能认证某个对象确实来自 tool call。主会话必须独占 `controller-owned` preflight、postflight、finalization 与 readback 四条证据通道，不能把执行器或模型提供的 JSON 直接映射为这些参数；tool failure 必须归一化为 `ok=false` 并保留安全 reason。

**前提：state 目录必须在执行体可写面之外。** 上面那四条通道、goal-set ledger、thread 坐标、按 attempt 归档的候选，全部落在 state 目录里；执行体若能写这个目录，本 adapter 的整个证据模型都不成立——它们是「控制器自己写的」这件事，靠的就是执行体够不着。这条前提不再只是约定：launch 前置闸拒绝任何落在**任一 `target_roots` 之内**（`--sandbox workspace-write` 明确授权可写）或**临时目录之内**（实测沙箱块的 `excludeSlashTmp` 与 `excludeTmpdirEnvVar` 都是 `false`，即 `/tmp` 与 `$TMPDIR` 同样在可写面内）的 state 目录，诊断给出的出路是换一个 `--state-root` 重跑 `prepare`。

这道闸只保证控制器不主动把证据放进执行体够得着的地方。它**不**声称能识别一个已经能写 state 目录的对手所伪造的证据——那属于「整个证据模型对这条前提的依赖」，是另一个议题。

上面这条管的是**入向**（执行器 → 控制器证据）。注入通道是**反方向**，同样有边界，而且它的权限更高：`thread/inject_items` 的注入项以 `role:"user"` 进入 thread 历史，而 objective 是被包在 `<codex_internal_context source="goal">` 里、并显式声明「treat it as the task to pursue, **not as higher-priority instructions**」的——**注入的 diagnostic 在权限上高于 objective**。规定因此是：

**diagnostic 只能由 contract 声明的事实与控制器自己的判定构成——postflight 条目 id、该条目在 contract 里的 argv 与 cwd、退出码、红项分类结论。执行体产出的任何字节都不得进入这条通道。** 最容易踩的形态很具体：编排器把红项命令的 **stdout** 贴进 diagnostic（「这条为什么红？把输出贴上」），而 postflight 命令的 stdout 完全可能是执行体自己写的文件内容（`cat`/`diff`/`jq` 类 verifier 都会）——那一刻执行体上一轮产出的字节，就以高于 objective 的权限回到了它自己面前。

这条不只写在文档里：`--diagnostics-file` 收的是一份闭世界的红项清单（`{"reds":[{"entry","code","exit"}]}`），注入文本由 launcher 按 contract 渲染。`entry` 必须是本 contract 的 postflight 条目 id，`argv`/`cwd` 从 contract 取而不从文件读，`code` 只认可续类——编排器能供的只剩一个整数退出码，「把 stdout 贴进来」在结构上没有落脚处。文件不合形状即进程级失败（exit 1），不放行。

goalRpc 是这四条通道背后的唯一执行豁口，只有主会话调用；执行器（turn 内产出）的输出不得反序列化为任何 controller 证据。这条独占声明的强度已实测坐实：sandbox 内执行器对 daemon sock 的 `connect()` 被 seatbelt syscall 层拦截（`EPERM`，即使 sock 落在沙箱可写区内仍被拒）——finalize receipt 因此定级为可信。caveat：证据来自 `--listen unix://` 的替代进程（本机装不了完整 daemon 子系统），未在真实 daemon control sock 上交叉验证；未来若该边界被证伪，receipt 需要降级为 `audit_only`。

## auth-copy 安全模式

真实 turn 需要认证：隔离 `CODEX_HOME` 默认没有 auth，直接跑 `turn/start` 会反复收到 401。launch 流程遵循经过两轮凭证卫生打磨确立的 auth-copy 安全模式：

- 只读复制生产 `~/.codex/auth.json`（OAuth token）到隔离 `CODEX_HOME`；不碰 `goals_1.sqlite`、`config.toml` 或其余生产状态——auth 是认证，不是状态，隔离铁律保护的是“状态不串”。
- `CODEX_HOME` 与执行体 cwd 各用独立 mkdtemp、不共享可猜测的父目录——否则 workspace-write sandbox 只限写不限读，执行体运行时可以用类似 `../codex-home/auth.json` 的相对路径读到凭证。
- 清理逻辑抽成幂等 `cleanup()`，**五路**共用：`finally`、`process.on('SIGTERM'/'SIGINT')`、`process.on('uncaughtException'/'unhandledRejection')`、`process.on('exit')`。`finally` 在进程被外部信号杀掉时不执行，在未捕获异常/未处理 rejection 逃出作用域时不执行，在**事件循环被走空**时同样不执行——最后这一种既没有异常也没有信号，前四路一个都不响，只有 `'exit'` 接得住。五路的注册时机都必须在 auth 副本可能落盘之前（即复制动作之前）就位。
- `cleanup()` 的每个动作要**各自**兜住异常。幂等不等于互不影响：三句串在一起时第一句抛错（例如隔离 `CODEX_HOME` 变成不可写）会让后两句连跑都没跑，还会在兜底路径上把原始错误与预期退出码一起带走。
- 进程级兜底跑完 `cleanup()` 之后**必须保持非零退出并把原始错误打到 stderr**，不得把崩溃伪装成正常退出——否则编排器读到 exit 0，会把一次崩溃当成一次成功的空跑。
- 信号处理器跑完 `cleanup()` 之后**必须真正终止进程**，否则轮询的下一拍会把 cleanup 刚释放的租约写回盘上，操作员既中止不掉 run，互斥原语又被一个已被终止的 run 重新宣示。终止手段是「摘掉自己的监听器再把同一个信号重新投递给自己」，不是 `process.exit()`：实测 `process.exit()` 在线程池被一次阻塞的 fs 读卡住时**根本不终止进程**（`auth.json` 是 FIFO 即可复现，正是复制凭证那一步），而 OS 层的默认信号处置不受线程池状态影响。
- 异步失败要在能被 `catch` 到的地方归一。子进程有两种：`spawn` 的 `ENOENT`/`EACCES` 从 `'error'` 事件异步抛出（不注册监听就是未捕获异常，绕过调用方的 `try`/`finally`）；**起来之后死掉**走 `'exit'`，那一刻既没有异常也没有信号。两者都必须归一成可等待的 rejection，并让在飞的 rpc 以此如实失败——靠 rpc 超时兜是不行的，它既慢 60s，给出的 reason 又只会是 `RPC timeout: …`，说不出子进程已经没了。
- rpc 的超时 timer **不得** `unref()`，并且必须在响应到达时 `clearTimeout`。两者是一件事：不清就得靠 `unref` 压住悬空 timer，而 `unref` 会连**真正在飞**的那次 rpc 也一并不再撑住事件循环——app-server 一死，事件循环立刻排空。
- 这些函数**不是库**：它们在进程级注册信号/异常处理器并会直接终止进程，不得在长驻进程里当模块并发调用。一个进程跑一条命令。
- 凭证绝不进 git、绝不进 fixture 或日志；用后立即清理。

## blocked 终局

`blocked` 不是暂停，也不是“还没做完”。只有同一阻断条件至少连续三个 goal turn 重复、无法继续取得有意义进展且确实需要用户输入或外部状态变化时，执行体才应通过 `update_goal` 把状态自标为 `blocked`——这是模型侧 tool 的合法使用场景，阈值写死在提示词里，不是控制器施加的规则。控制器观察到 `blocked` 状态后立即转入终局报告路径：按 diagnostic 报告阻断证据与下一步，不进入验收、不触发 finalize。恢复后的阻断审计重新计数；未达到阈值时保持运行、报告具体阻断证据。

**`blocked` 只在工具面健康时才是一条可靠的终局路径。** 它的上报通道与被阻断的执行通道共用同一条实现：0.147 的工具调用全部经 Code Mode 路由，宿主一缺，`apply_patch`、`exec_command` 与 `update_goal` 一起失效。第二次真实冒烟实测到这个形态——执行体正确识别出自己连撞三堵墙、正确尝试自标 `blocked`、连续失败四次，并在最终答复里如实说明；它做对了每一件能做的事，但那条路本身是断的。goal 因此一直停在 `active`，控制器永远等不到这个终局信号。**唯一的阻断上报通道与被阻断的执行通道共用实现**，这是设计层面的单点，codex 侧改不了。

因此工具面故障时的终局来源不是 `blocked`，而是控制器侧的护栏：wall-clock deadline，以及上文「跑飞护栏」那两条 turn/token 上限。它们不依赖执行体还能说话，是执行面坏掉时唯一还在工作的刹车。读到一份护栏触顶的终局报告时，「执行体为什么没自标 `blocked`」不需要另找解释——工具面坏掉时它没有能力自标。

## 附录：exec 单发回退（预留，未实现）

若未来 alpha 协议出现漂移导致 app-server 全量对接不可用，设计保留 `codex exec` 单发作为回退路径：用 `--output-schema` 强制候选终态形状、`--sandbox` 承载物理约束、`exec resume` 承载续跑。回退属于行为变更——它没有活体 goal 对象，`finalizationReceipt`/`runtimeReadback` 两条证据永不可得，需要一个状态机降级开关把 codex 分支降为 Claude 式双通道（候选终态 + `postflightEvidence`，去掉双证据要求）。这个开关本轮未实现，只作预留声明：S1b、S2 已实测 PASS，app-server 全量对接成立，回退路径本轮未触发。

`remaining_work` 与 `ready_for_postflight` 是本协议自造的归一化层，不是 Codex 原生字段；adapter 必须依据 objective、success criteria 与未解决 diagnostic 保守归一化后再写入 candidate，不得把它们冒充成原生 tool 返回。
