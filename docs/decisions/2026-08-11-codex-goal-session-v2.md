# ADR：Codex GoalSession v2 控制面

状态：Implemented on the Codex-only release branch

日期：2026-08-11

关联设计：../superpowers/specs/2026-08-11-codex-goal-session-v2-design.md

## 背景

Codex 侧当前把 Goal、Authority、Boundary、Condition 和 Attempt 聚合为一份需要完整哈希确认的 v1 contract。任何运行设计变化都会触发重新确认，使一个稳定 Goal 产生 V1 至 V8 式契约链。

这不是确认 UI 的表面问题，而是生命周期不同的对象被错误聚合。

## 决策

采用 Codex-only GoalSession v2：

- 用户确认稳定 Goal 与最大 Authority；
- Boundary 和 Condition 成为可根据 Evidence 动态演化的 Design Revision；
- v1 Run Contract 保持原 schema，作为不可变 AttemptManifest；
- 只有 Goal、Authority、风险、预算或标准弱化触发再授权；
- Executor 只能提出修订，GoalSession Controller 独立决策；
- root baseline 全 Session 唯一；
- 完成区分 Candidate、Verified 和 Certified；
- 持久化使用独立 Codex Controller 包、Node.js 24.15 及以上、内置 node:sqlite 与内容寻址 blob；
- Claude adapter、共享 v1 schema、共享 workflow 和根包 Node 要求不变；
- Grill 只用于设计评审，不进入 goal-condition 运行时。
- controller state 与 target root 拒绝 symlink alias，LaunchIntent 绑定 canonical path/device/inode；
- verifier 使用 default-deny Seatbelt 与资源上限，不能读取非授权宿主路径或控制宿主进程；
- `opt-in→default` 必须绑定真实动态修订 canary 的 Certified promotion receipt。
- promotion receipt 必须绑定当前安装 release 的外部 manifest digest；切换 release 后重新 canary；
- LaunchIntent/Attempt 绑定 controller release digest，prepare 后换版本必须在 dispatch 前拒绝；
- executor sandbox 由 Active Boundary 的 `write` Authority 投影为 `read-only | workspace-write`；
- Context dependency 只能位于 Active Boundary 内并在授权预览中显示；
- finalize 在 terminal mutation 前后执行 exact native turn fence，close 以 runtime quiescence 为释放租约前提。

## 备选

### Authority sidecar

改动较小，但形成双重事实源并延续补丁式架构。仅保留为迁移或紧急 fallback。

### 完整事件溯源策略服务

审计最强，但对当前本地单用户控制器过度设计。等出现远程多控制器或合规需求时再评估。

## 结果

正向结果：

- 同一 Goal 的正常修订不再反复确认；
- Authority 扩大仍保持用户控制；
- 动态 Condition 与 Evidence 局部失效成为一等能力；
- 可以检测控制面旁路与 false green；
- Codex 演进不影响 Claude。

代价：

- 新增 Codex 状态机、持久化、迁移和恢复复杂度；
- Codex v2 需要 Node.js 24.15 及以上；
- 必须先验证 sandbox、app-server readback 和 node:sqlite 行为；
- 已运行的 v2 Session 不能安全自动降级为 v1。

## 约束

- 未映射 Condition 不得 launch。
- 未分类 Revision 必须 fail closed。
- 缺少 ENFORCED 能力的 Hard Prohibition 不得执行。
- 缺少有效 Evidence 或存在未对账旁路时不得 Certified Complete。
- implementation plan 不得修改 Claude 或共享 v1 语义。
