---
name: goal-condition
description: 当用户要求把任务、边界包或已有完成条件编译成可确认、可验证的 Claude Code 或 Codex goal 运行契约时使用。
---

# goal-condition

本 skill 是平台无关的 router/compiler。Codex 只有 GoalSession v2 一个公开执行协议；Claude 使用共享 run contract。它不保存项目私有锚点，也不递归创建另一个 goal。

先 Classify，再按 runtime 分流：

```text
Codex: GoalSession v2 only
Compile Goal+Authority+Design → Preview → Confirm(authorization_hash)
→ Prepare Attempt → Launch → Verify → Revise/Next Attempt → Finalize → Close

Claude: Compile shared run contract → Validate → Preview → Confirm(contract hash)
→ Preflight → Launch(adapter) → Postflight → Close
```

## Classify

先把输入分为任务描述、boundary package、Claude run contract 或旧 Codex v1 contract。任务描述先用 boundary-design 补齐边界；boundary package 直接编译；Claude contract 仍须重新校验和预览；旧 Codex contract 只能进入 `migrate-v1`，不得继续执行。

一个 contract 只能有一个 single objective。输入若含多个可独立完成的目标，必须让用户选择一个；不得静默合并，也不得在本 skill 内启动子 goal 来拆分。

## Codex GoalSession v2

`runtime="codex"` 永远读取 [GoalSession v2 操作协议](references/codex-goal-session-v2.md) 与 [Codex adapter](references/adapters/codex.md)。controller 缺失、版本不兼容或 gate 未开放时 fail closed，并给出安装、升级或迁移下一步；不得回退到 Codex v1。

V2 release gate 是 `disabled → canary → enabled`：`disabled` 阻止 live；`canary` 只运行显式选择的 V2 canary；`enabled` 是正常 Codex 路由。`canary→enabled` 必须绑定当前安装 manifest digest、controller-owned Certified live canary receipt；换 release 后旧 receipt 失效。旧 rollout state 只做一次单向转换，不恢复旧执行协议。

普通命令省略 `--state-root`，共享机器级 controller store：显式 flag > `GOAL_CONDITION_CODEX_STATE_ROOT` > `$XDG_STATE_HOME/goal-condition/codex-v2` > `<home>/.local/state/goal-condition/codex-v2`。无效的高优先级输入 fail closed，不向低优先级回退；显式 override 是独立 deployment namespace，必须独立 rollout。

机器级 store 的 `session_id` 与 `run_id` 只能由 controller 生成 128-bit 随机 ID：调用方用 128-bit `request_id`/`nonce` 绑定创建请求，controller 在同一事务保存 resource 与 creation receipt；相同请求可找回原 ID，同 key 改输入 fail closed。`init`/`migrate-v1` 回传 session ID，`prepare`/`resume` 只持久化 Attempt 并回传 run ID，后续显式 `launch`；新建输入不得自选全局主键。

旧 Codex v1 contract 只能显式运行 `migrate-v1`。迁移保存输入与 provenance，创建未确认的 V2 Draft，并重新展示 Goal + Authority；旧确认、旧 runtime state 与旧完成证据都不继承，迁移后只能创建新的 V2 Attempt。

一次确认稳定的 Goal、Non-goals、Maximum Authority、机械 Hard Prohibition capability 与最大风险/预算；初始 Boundary 与 Conditions 会展示但不冻结进授权哈希。Authority 内的单调收紧、只追加 Condition、controller 读取 bytes 后的 Context refresh 形成 typed Design Revision，并在新的不可变 Attempt 继续，不重复确认整包。扩大 Authority 会追加 AuthorityRevision、生成新 authorization hash 并重新确认；弱化 Condition 或改变 Goal 必须 successor。verifier 等价替换与 controller correction 在独立 proof API 落地前 fail closed。

Compiler 只在缺失信息会导致两个实质不同、且不能采用保守默认时产生一个 blocking `CompilationGap`。Brainstorm/Grill 只用于设计前或对本 skill 做压力测试，绝不成为 runtime 命令、开放式访谈或 mandatory checklist。输入完整时直接编译。

每个 Attempt 必须先持久化 LaunchIntent 与 target-root lease；LaunchIntent 绑定当前 controller release digest 与 target root 的 canonical path、device、inode，再在同一事务把 intent/session 置为 `dispatching/Dispatching`，之后才能调用 launcher；dispatch 前版本和物理身份再核，claim 后任何崩溃或重试只 readback，绝不重发。没有 `write` Authority 的 Attempt 使用 `read-only` sandbox；获授 `write` 才能使用 `workspace-write`。

私有 `AttemptManifest` 继续通过共享 closed-world validator，但它只是一份 launcher ABI；其中 `version: 1` 是数据格式版本，不能作为 runtime 路由或 V1 fallback 信号。Context Package 与 Projection Proof 必须完整映射所有 active Conditions。

LaunchReceipt v2 以 controller 新建 thread 的空 turn 集为前态，并绑定 `turn/start` 响应 ID、带随机 controller correlation 的精确输入 SHA-256 与完成后唯一的持久化 turn ID；readback 必须机械核回同一输入且精确 `0→1`，finalize 前后也保持同一单 turn，否则都是 `CONTROL_PLANE_BYPASS`，不能 Certified。

Hard Prohibition 只能是 controller schema 枚举的 capability ID，且 `rule===capability`；只有 `ENFORCED` 才能启动。Context dependency 必须位于当前 Active Boundary 内并在首次预览展示路径与内容哈希。verifier 在 default-deny Seatbelt、最小环境与有界资源下运行；executor/runtime 只能给出 Candidate，controller Evidence 当前有效、无旁路且 finalize 原生读回归因成立，才可 Certified Complete。

## Claude shared run contract

### Compile

按 [run contract 字段与编译规则](references/run-contract.md) 和 [schema](schema/run-contract.schema.json) 生成 canonical JSON，并读取安装实例的 [项目 profile](references/anchors-and-rules.md)。它必须无损包含 single objective、stable context、`judgment_criteria`、`success_criteria`、`constraints`、`allowed_mutations`、`preflight`、`postflight` 与用户明确给出的 `budget.user_provided=true`。

`physical` 只用于已有可执行 mechanism 且有 verifier 的约束；否则写 `audit_only`。Claude 没有面向用户约束的物理面，因此约束一律是 `audit_only`。预算不得推测，`budget.max_turns` 只接受正整数。

### Validate、Preview 与 Confirm

从本 skill 根目录调用 [validator](scripts/validate-contract.mjs)：

```text
node scripts/validate-contract.mjs --contract <contract-file> --preview
```

落盘必须是 `canonicalJson(parsed)` 的 canonical JSON bytes。`readContract` 会做无 BOM strict UTF-8、JSON 与 byte-identical 检查；任何 diagnostic 都保留安全字段位置和指纹，用户值与 parser message 不得原样回显。校验失败即停止。

向用户展示完整 preview，并原样附 authoritative canonical JSON。只有针对这段 bytes 的 SHA-256 确认有效；任何编辑都要重新 Validate、Preview、Confirm。用户说“直接跑”不等于确认未展示的 hash。

### Preflight 与 Launch

确认后才按 [snapshot 协议](references/run-contract.md#preflight-与可信-baseline-digest) capture baseline，并把 `baseline_digest` 存入 baseline 文件之外的可信状态。主会话建立 `{contractHash,baselineDigest,runId}` binding 和 controller-owned `preflightEvidence`；缺失、失败或不匹配都禁止 launch。

只把已确认 contract 交给 [Claude adapter](references/adapters/claude.md)。真实启动仅由 `scripts/launch.mjs` 承担；adapter 不得补写目标、预算或权限承诺。

### Postflight 与 Close

runtime 候选终态后，启动它的主会话独立执行 postflight 和 baseline compare，提交同一 binding 的 controller-owned `postflightEvidence`。执行会话不得自证；产物缺失、未授权 mutation、权限错误或 remaining work 都 fail closed。

红项必须先过 `classifyPostflightRed`：可续类走 adapter 的 resume，终局类停止；未知 code 终局。馈回 diagnostic 只能来自 contract 与控制器判定，不得包含执行体产出的字节。状态机即使对两类都返回 `reject`，编排器仍必须执行该分流，做到可续类续跑。

只有既有状态机返回 `complete` 才可 Close。其余状态按安全 diagnostic 报告真实差异，不得改写为完成。
