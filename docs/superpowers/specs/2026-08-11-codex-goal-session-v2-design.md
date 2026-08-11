# Codex GoalSession v2 设计

状态：八节设计已逐节确认；待文档总审与实现计划

日期：2026-08-11

决策范围：仅 Codex 侧契约与控制面

## 0. 决策摘要

本设计将 Codex 侧稳定的 Goal、用户授予的 Authority、动态演化的 Boundary / Condition 与单次不可变 Attempt 分离。

用户首次确认的对象不再是完整且持续变化的运行契约，而是：

~~~text
Authorization Binding
= Goal
+ Non-goals
+ Maximum Authority
+ Hard Prohibitions
+ Maximum Risk / Budget
~~~

控制器在这个授权包络内，根据 controller-owned Evidence 自动缩小或扩大 active boundary、增加或收紧 Condition、修复投影与验证器问题。只有 Goal、Authority、风险、预算或完成标准的授权语义发生变化时，才重新打断用户。

现有 v1 Run Contract 不废弃，也不扩展。它在 Codex v2 中成为每个 Attempt 的不可变投影。Claude adapter、共享 v1 schema 和共享 workflow 语义保持不变。

本设计明确排除将 Grill 产品化。Brainstorm / Grill 是本次设计评审方法，不是 goal-condition Skill 的运行时组件、提示词流程或状态机。

## 1. 问题与根因

### 1.1 观察到的失败

同一个端到端 Goal 在实际 Codex task 中经历了多版契约与多次完整哈希确认：

- 外部路径逃逸使某版 contract 失效；
- 原生 Codex objective 的长度上限使另一版无法创建；
- 诊断 gate 全绿后，独立 review 仍发现 false-green blocker；
- 每次 Boundary、Condition、Context 或 verifier 调整都被当作新契约；
- 控制器因此反复要求用户确认 V1、V2 直至 V7/V8，而 Goal 本身并未改变。

### 1.2 根因不是确认按钮，而是聚合边界错误

当前线性流程把四类生命周期不同的对象压进一个 canonical contract：

| 对象 | 正确生命周期 | 当前错误 |
|---|---|---|
| Goal | 整个任务稳定 | 任一运行细节变化都像 Goal 变化 |
| Authority | 由用户授予，低频修订 | 与执行设计共同哈希 |
| Boundary / Condition | 随证据动态演化 | 每次变化强制重新确认 |
| Attempt | 单次执行不可变 | 被当成整个 Goal 的永久契约 |

现有流程是单向的 Classify → Compile → Validate → Preview → Confirm → Launch → Postflight → Close，没有一等的 Revising 状态，也没有判断某个变化是否仍在授权包络内的 Revision Policy。

因此，重复确认是数据模型和状态机的必然结果，不是 UI 文案或哈希展示方式的表面 bug。

## 2. 目标、非目标与硬边界

### 2.1 目标

- 一个稳定 Goal 正常情况下只做一次初始授权确认。
- Boundary 和 Condition 能基于新 Evidence 动态演化。
- 单调收紧、控制器纠错和 Authority 内调整不重新确认。
- Authority 扩大、风险增加、完成标准弱化和 Goal 改变必须重新授权。
- 保留完整审计、可重放、不可洗白的 root baseline。
- 区分 Candidate、Verified 与 Certified，消除 false-green completion。
- 解决 Codex objective 长度与控制面旁路问题。
- 只改变 Codex 侧，不改变 Claude 或共享 v1 合约语义。

### 2.2 非目标

- 不为 Claude 引入 GoalSession v2。
- 不重写共享 workflow 或 v1 Run Contract schema。
- 不把 Grill、开放式访谈或固定轮次追问加入 goal-condition。
- 不使用另一个 LLM 充当独立授权控制器。
- 不宣称 Prompt 能提供物理安全隔离。
- 不自动清理、覆盖或回滚用户与外部进程的工作区修改。
- 不把历史不可验证的确认或 baseline 伪装成可信 Receipt。

## 3. 方案比较与选择

| 方案 | 说明 | 收益 | 代价 | 决策 |
|---|---|---|---|---|
| A：Authority sidecar | 在现有 v1 contract 旁增加 Codex authority 文件和修订分类器 | 改动小、迁移快 | 双重事实源、容易继续堆补丁 | 仅作迁移与紧急 fallback |
| B：GoalSession v2 | Codex-only 控制面；v1 contract 降为 AttemptManifest | 根因级分层、动态修订、可审计 | 新状态机、存储和迁移成本 | 采用 |
| C：完整事件溯源策略服务 | 所有变化均事件化，独立服务执行策略 | 最强审计与多控制器扩展 | 当前本地工具明显过度设计 | 延后 |

选择 B。A 不作为最终架构；C 只有在出现远程多控制器、多人协作或合规审计需求时再评估。

## 4. 核心模型与不变量

### 4.1 GoalSession

GoalSession 是 Codex 控制面的权威聚合根：

~~~text
GoalSession
├── schema_version
├── session_id
├── status
├── goal
├── non_goals
├── root_baseline
├── authority_revisions[]
├── design_revisions[]
├── attempts[]
├── evidence[]
├── confirmation_receipts[]
├── decision_ledger[]
├── predecessor_session_id?
└── successor_session_id?
~~~

权威状态只存在于 Controller Store。Executor 可以提出 proposal，但不能修改 GoalSession。

### 4.2 四类独立哈希

- goal_hash：Goal 与 Non-goals 的 canonical hash。
- authority_revision_hash：某版 Authority、Hard Prohibitions、风险与预算上限的 hash。
- authorization_hash：goal_hash 与 authority_revision_hash 的组合绑定。
- design_revision_hash：当前 Active Boundary 与 ConditionSet 的 hash。
- attempt_hash：Design、Context Package、v1 manifest、preflight 与 postflight 定义的 hash。

用户确认 authorization_hash。presented_design_hash 只记录确认时用户看到的初始设计，不把该设计冻结成授权对象。

### 4.3 必须始终成立的不变量

~~~text
GoalHash[n] equals GoalHash[0]
ActiveBoundary[n] is a subset of ConfirmedAuthority[k]
AutoCondition[n] implies Condition[n-1]
Risk[n] does not exceed ConfirmedMaximumRisk[k]
Budget[n] does not exceed ConfirmedMaximumBudget[k]
RootBaseline[n] equals RootBaseline[0]
~~~

自然语言蕴含不可判定。Controller 不接受模型输出的 monotonic=true 作为证明，只允许封闭的 typed revision operation 自动应用。

## 5. Authority、Design、Condition 与 Evidence

### 5.1 Authority Revision

Authority 至少描述：

- 允许访问的最大目标根；
- 允许的读、写、执行、网络和外部副作用；
- 允许引用的 secret 类别，不含 secret 值；
- 破坏性操作许可；
- 最大风险等级；
- 最大预算；
- Hard Prohibitions。

Authority 可以通过新的 Confirmation Receipt 扩大。控制器不会改写已经确认的 Maximum Authority；日常最小权限通过收紧 Active Boundary 和当前 Attempt capability 实现。

用户可以显式撤销 Authority。撤销会产生新的 Authority Revision，并要求先停止或对账仍依赖被撤销能力的 Attempt。之后若要恢复已经撤销的能力，仍需新的 Receipt。

### 5.2 Design Revision

Design Revision 包含：

- Active Boundary；
- ConditionSet；
- 当前 Context 依赖；
- Projection 版本；
- Revision 原因；
- 前一 revision hash；
- 触发 Evidence 或 controller fact。

Design 是动态执行设计，不是用户授权本身。

### 5.3 Condition

Condition 使用稳定身份：

~~~text
Condition
├── id
├── kind: judgment | success | invariant
├── rule
├── verifier
├── depends_on[]
├── introduced_by
└── strengthens[]
~~~

Condition 定义中不保存可变的 satisfied 状态。是否满足由独立 Evidence 表达。

### 5.4 Evidence

~~~text
Evidence
├── evidence_id
├── condition_id
├── verifier_id
├── verifier_version_hash
├── attempt_id
├── input_hashes[]
├── result
├── output_hash
├── captured_at
├── expires_at?
└── controller_owned
~~~

Executor 输出、reviewer 文字和模型总结默认都不是 controller-owned Evidence。

## 6. 双层状态机

### 6.1 GoalSession 状态

~~~text
Drafting
→ AwaitingConfirmation
→ Ready
→ Running
→ Evaluating
→ Revising
→ Ready
~~~

附加分支：

- AwaitingReauthorization：需要新的授权语义。
- ReconciliationRequired：旁路、模糊启动结果或外部修改尚未对账。
- Blocked：缺少能力、状态损坏或真实外部阻断。
- Complete：Certified Complete。
- Superseded：Goal 改变后由 successor GoalSession 取代。

### 6.2 RunAttempt 状态

~~~text
Prepared → Launched → Candidate → Rejected | Verified
~~~

首次 turn/start 才创建真实 Attempt。preflight 或投影失败不消耗 Attempt。

原生 Codex goal 的 active、paused、blocked、usage_limited、budget_limited、complete 只属于 adapter 运行态，不直接等同于 GoalSession 状态。

## 7. Revision Policy

### 7.1 封闭操作集

- ADD_CONDITION
- ADD_AND_VERIFIER
- TIGHTEN_TYPED_THRESHOLD
- NARROW_ACTIVE_BOUNDARY
- EXPAND_WITHIN_AUTHORITY
- REFRESH_CONTEXT
- REPLACE_EQUIVALENT_VERIFIER
- CONTROLLER_CORRECTION
- EXPAND_AUTHORITY
- WEAKEN_CONDITION
- CHANGE_GOAL
- UNCLASSIFIED

### 7.2 决策矩阵

| 操作 | 默认决策 | 额外条件 |
|---|---|---|
| ADD_CONDITION | 自动 | 不引入新交付物 |
| ADD_AND_VERIFIER | 自动 | 新 verifier 受控且依赖已声明 |
| TIGHTEN_TYPED_THRESHOLD | 自动 | 类型化顺序可证明更严格 |
| NARROW_ACTIVE_BOUNDARY | 自动 | 不破坏已承诺交付 |
| EXPAND_WITHIN_AUTHORITY | 自动 | Controller 根据结构化 Evidence 批准 |
| REFRESH_CONTEXT | 自动 | 依赖 Evidence 局部失效 |
| REPLACE_EQUIVALENT_VERIFIER | 自动 | 通过 parity 或 mutation proof |
| CONTROLLER_CORRECTION | 自动 | 只修复投影、路径或控制器错误 |
| EXPAND_AUTHORITY | 重新授权 | 生成 Authority Revision |
| WEAKEN_CONDITION | 重新授权或 successor | 不允许伪装成 verifier 修复 |
| CHANGE_GOAL | successor GoalSession | 保留 predecessor unresolved violations |
| UNCLASSIFIED | fail closed | 不信任自然语言自分类 |

故障 verifier 不能通过删除 Condition 来修复。只有证明语义等价后，才能替换 verifier。

### 7.3 原生运行状态

- turn/start 前失败：不创建 Attempt。
- boundary violation：不自动 resume。
- paused / usage_limited：进入 Blocked，不自动绕过。
- budget_limited：只有用户提高预算后才恢复。
- workspace 可能变化：先比较 snapshot，再决定 revision。

## 8. Contract Compiler、确认与再授权

### 8.1 Compiler 不是 Grill

Contract Compiler 只把已知任务、task context、代码事实、环境事实和保守默认值编译为 Goal、Authority、初始 Boundary 与 ConditionSet。

只有出现真正阻塞的 CompilationGap 才提问。每个 Gap 必须指出：

- 缺失或矛盾的字段；
- 会导致哪两种实质不同的执行结果；
- 为什么不能采用更保守的默认值；
- 用户只需决定什么。

偏好问题、可自行检查的问题和可在执行中验证的问题不能形成 CompilationGap。

### 8.2 首次确认预览

预览展示：

- Goal 与 Non-goals；
- Maximum Authority；
- Hard Prohibitions；
- 初始 Active Boundary；
- 初始 ConditionSet；
- 允许的自动调整；
- 再授权触发器；
- 保守假设；
- 短指纹。

用户不需要复制完整 SHA-256。Controller 自动生成 Receipt：

~~~text
ConfirmationReceipt
├── receipt_version
├── session_id
├── goal_hash
├── authority_revision_hash
├── authorization_hash
├── presented_design_hash
├── short_fingerprint
├── confirmed_at
├── thread_id
├── turn_or_message_ref
└── confirmation_source
~~~

Receipt 证明 Controller 观察到了确认，不宣称它是用户的密码学签名。

### 8.3 自动修订摘要

Authority 内修订只在 Attempt 边界展示短摘要：

~~~text
Design D2 → D3
增加：C7 回归验证
边界：缩小到 packages/report
失效 Evidence：E12、E15
原因：Attempt A2 暴露未覆盖路径
无需重新授权
~~~

### 8.4 再授权

以下变化进入 AwaitingReauthorization：

- Goal 或交付物语义变化；
- 超出 Maximum Authority；
- 提高预算或风险；
- 新增 secret、外部写入或破坏性操作；
- 弱化 Condition；
- 放弃 Hard Prohibition；
- 无法分类的变化。

再授权只展示差异、原因、风险、范围内替代方案和新指纹，不重新要求确认整份大契约。

## 9. Attempt 投影与 Context Package

### 9.1 CodexAttemptEnvelope

GoalSession v2 不向共享 v1 schema 增加字段：

~~~text
CodexAttemptEnvelope
├── session_binding
│   ├── session_id
│   ├── authorization_hash
│   ├── design_revision_hash
│   ├── attempt_id
│   └── root_baseline_hash
├── manifest
│   └── 完全兼容的 v1 Run Contract
├── context_package_ref
└── projection_proof_ref
~~~

共享 workflow 只接收 manifest。Envelope 只由 Codex Controller 管理。

### 9.2 Projection Proof

每个 Active Condition 和 session 字段必须映射到：

- v1 manifest 字段；
- runtime-visible Context Package 位置；
- verifier；
- Evidence 依赖。

任何未映射的 Active Condition 都阻止 launch。

### 9.3 解决 objective 长度限制

原生 Codex goal objective 只承载短且稳定的 Goal。完整 Boundary、Condition、Context 与验证要求由 Controller 从不可变 blob 读取，并作为 hash-bound Context Package 注入 turn/start input。

Executor 不获得 Controller Store 路径，只获得该 Attempt 所需内容。Controller 通过 app-server readback 验证 turn 与 Context Package hash 的绑定。

### 9.4 两类 baseline

- root_baseline：GoalSession 全程唯一，用于最终 mutation audit。
- attempt_start_snapshot：仅用于增量诊断。

后续 revision 不得重新捕获 root_baseline。Authority 扩大改变允许分类，但不改变历史基线。successor GoalSession 必须继承 predecessor 的 unresolved violations。

## 10. Evidence 依赖与局部失效

依赖图为：

~~~text
Condition
→ Verifier
→ Context / Artifacts / Boundary / Runtime Version / Attempt
→ Evidence
~~~

失效规则：

| 变化 | 失效范围 |
|---|---|
| 新增 Condition | 只失效该 Condition |
| Context 变化 | 失效依赖该 Context 的 Evidence |
| verifier 变化 | 失效该 verifier 产生的 Evidence |
| Active Boundary 扩大 | snapshot、preflight 与受影响验证 |
| 仅投影格式变化 | Projection Proof 与 Attempt，不失效业务 Evidence |
| 代码或产物变化 | 失效依赖相应 artifact hash 的 Evidence |
| runtime 版本变化 | 失效声明依赖该版本的 Evidence |
| Authority 扩大 | 强制新 preflight，root baseline 不变 |

Completion 必须检查缺失、过期、依赖失效、未知版本、旧 verifier 和非 controller-owned Evidence。

Reviewer finding 的合法升级链：

~~~text
Reviewer finding
→ Controller fact check
→ Typed revision proposal
→ Revision Policy
→ Condition revision
→ Deterministic verifier
→ Controller-owned Evidence
~~~

## 11. Codex 控制面与信任边界

### 11.1 组件

- Contract Compiler
- GoalSession Controller
- Revision Policy
- Attempt Projector
- Attempt Supervisor
- Evidence Engine
- Trusted Session Store

Codex adapter 是新控制面与现有 app-server 的薄接入层。

### 11.2 信任层级

| 层级 | 组件 | 权限 |
|---|---|---|
| T0 | 用户确认 | 授予或扩大 Authority，改变 Goal |
| T1 | GoalSession Controller | 哈希、策略、状态提交 |
| T2 | 受控 verifier | 根据声明依赖产生 Evidence |
| T3 | Codex Executor | 修改目标、提出诊断与 proposal |
| T4 | 工作区和外部环境 | 可变且必须验证的输入 |

独立控制器指权限独立，不是换一个模型审批。Executor 的 all_green 或 monotonic 声明没有权威性。

### 11.3 Codex-only 运行边界

仓库根包继续保持 Node.js 20 及以上和现有依赖面。新增：

~~~text
goal-condition-template/
├── existing shared runtime
└── codex-controller/
    ├── package.json
    ├── engines: Node.js 24.15 及以上
    └── 使用内置 node:sqlite
~~~

原因：

- node:sqlite 在 Node.js 22.5 引入；
- Node.js 24.15 中进入 release-candidate 稳定级别；
- 本机 Node.js 24.15 已验证可以加载该模块；
- 独立包避免给 Claude 和共享根包增加第三方数据库依赖或提高 Node 要求。

Node 版本不足时，Codex v2 preflight 明确失败或保留 legacy 模式，不静默退化为弱文件存储。

### 11.4 持久化

平台默认 Controller state 目录位于目标工作区之外：

- macOS：用户 Application Support 下的 goal-condition/codex；
- Linux：XDG_STATE_HOME 下的 goal-condition/codex。

目录权限默认 0700，数据库和敏感元数据默认 0600。

~~~text
Codex controller state/
├── sessions.db
├── blobs/
│   └── sha256/<digest>
└── exports/
    └── <session-id>/
~~~

- SQLite/WAL 保存 Session、revision pointer、Attempt、Evidence index、Receipt 与 append-only ledger。
- 内容寻址 blob 保存 canonical objects、baseline、snapshot、Projection Proof 和 verifier 输出。
- exports 是可重建审计导出，不是事实源。
- Secrets 只保存 secret_ref，不进入哈希、日志、Evidence 或导出。
- ledger event 记录 previous_event_hash，用于发现意外篡改或损坏；这是 tamper-evident，不抵抗拥有本机完整权限的攻击者。

最小 fallback 是 session.json、ledger.jsonl 与 atomic rename。它仅用于迁移或紧急恢复，不是最终主路径。

### 11.5 原子提交

~~~text
compareAndCommit(expectedRevision, typedEvent)
~~~

一次事务必须完成：

1. 校验当前 revision；
2. 执行 Revision Policy；
3. 追加 ledger event；
4. 更新 materialized state；
5. 注册 immutable blob；
6. 递增 revision。

并发冲突必须重新读取和分类，不能 last-write-wins。

## 12. 控制面旁路与能力降级

### 12.1 执行等级

| 等级 | 含义 | 可满足 Hard Prohibition |
|---|---|---|
| ENFORCED | 运行时或沙箱从机制上阻止 | 是 |
| DETECTED | 只能可靠事后发现 | 否 |
| DECLARED | 只依赖 Prompt 或模型自律 | 否 |
| UNAVAILABLE | 无法验证 | 否 |

Hard Prohibition 如果只有 DETECTED、DECLARED 或 UNAVAILABLE，preflight 必须失败。

### 12.2 Attempt capability 与 Launch Receipt

每个受控 turn 使用一次性 capability：

~~~text
session_id
attempt_id
design_revision_hash
contract_hash
workspace_digest
nonce
expires_at
controller_mac
~~~

启动顺序：

~~~text
LaunchIntent → turn/start → LaunchReceipt
~~~

Receipt 将 capability 与真实 thread_id、turn_id 绑定。capability 证明该 Turn 由 Controller 发起，但不授权 Executor 修改 GoalSession。

Controller MAC key 在首次初始化时生成，只保存在权限为 0600 的 Controller state 中，并以 key_id 支持轮换。Capability 主要提供来源绑定和重放检测；如果运行时无法隔离 key 与状态目录，它不能被宣称为强安全边界。

### 12.3 直接续跑与外部修改

未经 Launch Receipt 的 Turn 标记为 CONTROL_PLANE_BYPASS：

- GoalSession 进入 ReconciliationRequired；
- 旁路期间变化标记为 out_of_band_change；
- 相关 Evidence 局部失效；
- 对账前不能 Certified Complete。

Controller 不阻止用户直接使用 Codex，但不能把旁路执行认证为受控结果。

每次 Attempt 比较 root baseline、上一 snapshot、当前 digest、Git 状态和必要的非 Git 文件摘要。未知来源修改不自动删除或回滚。

### 12.4 并发与租约

同一 target root 默认最多一个受控可写 Attempt。只读验证可以并发。租约超时后必须先核对真实 Codex turn 与工作区，不能立即抢占。

### 12.5 完成分级

- Candidate Complete：Executor 声称完成。
- Verified Complete：所有 Condition 均有有效 Evidence。
- Certified Complete：Verified，且无旁路、状态损坏、未对账修改或授权违规。

只有 Certified Complete 可以成为 GoalSession 的最终绿色成功。

## 13. 错误处理与恢复

启动前先持久化 launch_intent 和 run_id，再调用 app-server。

恢复顺序：

1. 验证事件链和 blob；
2. 检查 Attempt lease；
3. 查询相同 run_id 的 task / turn；
4. 比较 workspace 与 root baseline；
5. 验证 Evidence 依赖；
6. 决定继续 Evaluating、进入 Revising 或 ReconciliationRequired。

无法确定请求是否已送达时，不重复启动。

| 故障 | 处理 |
|---|---|
| ledger hash chain 损坏 | Blocked: StateIntegrityFailure |
| blob 缺失或摘要不符 | 失效相关 Evidence，禁止完成 |
| app-server 无 readback | 保持最后安全状态 |
| sandbox 能力下降 | 重跑 capability preflight |
| verifier 版本未知 | 对应 Evidence 失效 |
| Turn 启动结果不明确 | ReconciliationRequired |
| Controller 不支持 schema | 只读打开并迁移 |

状态损坏不能通过建立一个空白 Session 洗掉。successor 必须携带 predecessor unresolved violations。

## 14. Codex-only 迁移与灰度

### 14.1 改动边界

允许：

- 修改 Codex adapter；
- 新增 codex-controller；
- 新增 Codex schema、fixture、测试和文档；
- 新增 Controller Store。

禁止：

- 修改 Claude adapter 语义；
- 修改共享 v1 Run Contract schema；
- 修改共享 workflow 行为；
- 修改 Claude snapshot；
- 在根包加入仅 Codex v2 所需的依赖或提高根包 Node 要求。

### 14.2 Legacy adoption

已有 v1 task 默认继续 legacy。只有用户明确 Adopt into GoalSession 才迁移：

1. 读取最新 v1 contract、历史版本和 runtime readback；
2. 推导 Proposed Goal、Authority、Boundary、ConditionSet；
3. 保存 legacy_import；
4. 做一次新的 Goal + Authority 确认；
5. 建立 Authorization Receipt；
6. 从 adoption 时刻开始使用 v2。

无 Receipt 的历史确认标记为 legacy_confirmation_unverified。

无法恢复原始 baseline 时：

- 标记 baseline_provenance = adopted_at_current_state；
- 只认证 adoption 之后的修改；
- 不给 adoption 前交付完整 Certified Complete；
- 用户可接受当前状态为 successor GoalSession 的新起点，但不能改写旧历史。

### 14.3 灰度阶段

| 阶段 | 行为 | 进入门槛 |
|---|---|---|
| Shadow | v1 执行，v2 只重放和分类 | 分类稳定、无状态污染 |
| Opt-in | 新 Codex Session 可选 v2 | 恢复与旁路测试通过 |
| Codex Default | 新 Codex Session 默认 v2 | 无重复 Turn、无错误再授权 |
| Legacy Freeze | 不再新建 legacy | 迁移与回滚成熟 |

### 14.4 回滚

关闭 v2 后：

- 新任务可暂时使用 legacy；
- 已有 v2 Session 冻结或只读；
- 不自动把运行中的 v2 Session 降级为 v1；
- 可以导出 Session、AttemptManifest 与 Evidence；
- 恢复 v2 后从最后提交事件继续。

State schema 必须显式带 schema_version。迁移默认向前、尽量 additive；升级前生成一致性备份与审计导出，不自动执行不可逆降级。

## 15. 验证策略

### 15.1 状态机属性

实现必须以 model-based / property-based testing 验证：

~~~text
I1  Goal 不自动改变
I2  Authority 无 Receipt 不扩大
I3  自动 Condition Revision 只保持或加强
I4  root_baseline 不可替换
I5  Executor 不能批准自己的 proposal
I6  无有效 Evidence 不能 Verified
I7  有旁路或未对账修改不能 Certified
I8  同一 target root 最多一个受控写 Attempt
I9  模糊启动结果不产生重复 Turn
I10 Claude 与共享 v1 行为不变
~~~

事件生成至少覆盖并发提交、崩溃点、Evidence 失效、Authority 变化、外部修改和 app-server 超时。

### 15.2 Projection 测试

- 每个 Active Condition 都有 Projection Proof 映射；
- v1 manifest 继续通过原 validator；
- canonical replay 得到相同 hash；
- Context Package 缺失、截断或 hash 不符时禁止启动；
- 超过 4000 字符的 Boundary / Condition fixture 仍能通过 turn/start context 传递；
- native objective 始终保持短 Goal。

### 15.3 Mutation 与 false-green 测试

故意删除断言、改失败码、复用旧 Evidence、替换 verifier 版本、漏跑 gate、伪造 reviewer 结论。任何变异仍得到 Certified Complete 都是发布阻断。

### 15.4 故障注入

在 LaunchIntent、turn/start、Receipt、workspace mutation、verifier、Evidence commit 和 Session commit 前后注入崩溃。

恢复必须不重复启动、不丢已提交事实、不接受半写 Evidence、不重捕获 root baseline。

### 15.5 真实事故回放

固定回归场景：

1. 同一个稳定 Goal 已确认；
2. 发现外部路径问题；
3. objective 超长；
4. 八个诊断 gate 全绿；
5. reviewer 发现 false-green blocker；
6. 增加 Condition 并继续。

预期：

- 初始只确认一次；
- Authority 内 Boundary 调整不确认；
- 真正扩大 Authority 最多新增一次差异化确认；
- objective 投影修复不确认；
- reviewer blocker 触发 Evidence 失效与新 Attempt，不确认；
- 不出现 V2 至 V8 的完整契约确认链；
- 只有 Evidence 全部有效才 Certified Complete。

## 16. 发布门槛与观测指标

进入 Codex Default 前必须满足：

- 重复确认事故回放通过；
- Authority 扩大百分之百要求新 Receipt；
- 故障注入无重复 Turn；
- mutation testing 无 false certified green；
- 历史缺 baseline 导入全部明确降级；
- Claude snapshots、共享 schema 和 workflow 行为不变；
- Shadow 阶段不存在 v2 自动接受真实越权；
- secrets 不进入数据库、hash input、日志与 exports；
- path canonicalization 覆盖 dot-dot、symlink 和大小写绕过。

本地结构化指标：

- initial confirmation count；
- reauthorization count 与原因；
- automatic revision count；
- UNCLASSIFIED ratio；
- attempts per Goal；
- duplicate launch prevention；
- bypass count；
- Evidence invalidation fan-out；
- Candidate / Verified / Certified completion rate；
- legacy 与 v2 分类差异。

核心成功指标：

~~~text
在不增加 false certified green 的前提下，
减少同一 Goal 内不必要的重复确认。
~~~

## 17. 实现前必须完成的 spike

以下事实可能随 Codex / Node 版本变化，必须 fail-closed 验证：

1. 当前 Codex sandbox 能否拒绝 Executor 读取 Controller state 目录；
2. app-server readback 能否稳定绑定 run_id、thread_id、turn_id 与 Context Package；
3. 无 task-level lock 时，直接续跑能否被完整检测；
4. Node.js 24.15 及以上 node:sqlite 的 WAL、defensive mode 与崩溃行为；
5. 路径 canonicalization 对 symlink、大小写和多 root 的真实行为。

Spike 失败不推翻本设计，而是按能力矩阵降级为 DETECTED、UNAVAILABLE、Blocked 或 ReconciliationRequired；不得静默改成 Prompt 约束。

## 18. 理论与业界依据

- [PIVOT](https://arxiv.org/abs/2605.11225) 的 PLAN–INSPECT–EVOLVE–VERIFY：保留已验证前缀，只重写不受支持部分，并以验证反馈推动演化。
- [多约束协作规划](https://aclanthology.org/2025.coling-main.672/)：把约束分解、冲突检测与动态调整作为显式规划过程。
- [Simplex Runtime Assurance](https://arxiv.org/abs/2102.12981)：把自适应但不可信的执行器与可信安全控制器分离。
- [NIST ABAC](https://csrc.nist.gov/pubs/sp/800/162/upd2/final)：授权依据主体、对象、动作、环境属性和策略，而不是一次性自由文本。
- [Codex best practices](https://learn.chatgpt.com/guides/best-practices#plan-first-for-difficult-tasks)：区分 Goal、Context、Constraints 与 Done。
- [Node.js SQLite](https://nodejs.org/download/release/v24.15.0/docs/api/sqlite.html)：node:sqlite 的版本与稳定性历史。

## 19. 后续步骤

1. 文档总审，确认没有把 Grill 产品化或改变 Claude 边界。
2. 使用 writing-plans 生成分阶段实现计划。
3. 先完成第 17 节 spike 与 Shadow 模式。
4. 通过测试门禁后才进入 Opt-in。
