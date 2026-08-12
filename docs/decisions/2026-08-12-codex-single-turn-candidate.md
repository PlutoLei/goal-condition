# ADR：Codex 单回合 Candidate 协议

状态：Implemented

日期：2026-08-12

## 根因

Codex 原生 goal 在仍为 `active` 时会自动续起下一 turn。原协议一面要求 Controller 只授权一个带 correlation 的 `turn/start`，一面又只说“持续工作直到 complete”，没有要求执行器在首个 turn 返回前提交原生终态。真实 canary 因而出现：工作与 verifier 已完成，但执行器把“Controller 才能认证”误解为“自己不能写 complete”，首轮以 active 结束，服务端自动续起第二轮，严格因果门禁随后正确拒绝。

这是 Candidate 信号与 Certified 决策的职责边界表达不完整，不是 turn ID 匹配的表面 bug。

## 决策

- 一个 GoalSession Attempt 精确对应一个 controller-started native turn。
- Controller 在 exact turn input 中明确：原生 goal 已存在，不得调用 `create_goal`。
- 执行器只在 Attempt 工作确实完成时、首轮结束前调用 `update_goal(status="complete")`。
- 该 complete 只形成不可信 Candidate；verify、finalize 和 Certified 仍完全属于 Controller。
- 执行器不得以 active 状态发送会结束首轮的 final response。无法安全完成时不得伪造 complete，由有界 runtime 护栏终止。
- correlation 后的协议文本由一个共享函数生成并哈希，避免 Controller prompt 与 launcher 漂移。
- 严格 `0→1` turn 因果栅栏保持不变；任何自动续轮仍是 `CONTROL_PLANE_BYPASS`。

## 备选与 trade-off

### 最小改动：接受第二个自动 turn

可以让首轮 canary 变绿，但会扩大授权集合，无法再证明哪个 turn 由 Controller 发起，也会把真实旁路洗白。拒绝。

### 仅改一句提示词

改动最小，但 Controller 构造 prompt 与 launcher 追加文本仍有两个事实源，后续容易再次漂移。只保留为紧急 fallback。

### 选定方案：单一协议源 + 单回合因果边界

改动多一个共享 helper 与协议测试，但不降低安全门槛，同时把 Candidate 与 Certified 的职责明确机械化。代价是一个 Attempt 不能依赖原生自动续轮；较大的工作应在同一 turn 内继续调用工具，或由 GoalSession revision 创建下一个 immutable Attempt。
