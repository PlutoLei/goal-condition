# Codex GoalSession v2 操作协议

本协议适用于所有 Codex live execution。Codex 不再公开或回退到 v1 lifecycle；旧 v1 contract 只能作为 `migrate-v1` 的一次性输入。Claude 走独立共享 contract 分支。controller 入口是：

```text
node codex-controller/src/cli.mjs <command> ...
```

Controller state 与 runtime state 必须在所有 target root 和系统临时目录之外；state/target root 及已有祖先必须使用 canonical physical path，不接受 symlink alias。每条命令 stdout 只输出一个 JSON；stderr 只输出安全错误码。Node.js 必须至少为 24.15。

## 1. Rollout 与能力

先用 `mode get` 读取 `disabled | canary | enabled`；输入固定为 `{"action":"get","next":null,"changed_at":null,"canary_session_id":null}`。缺失状态等于 `disabled`。controller 在 `prepare/launch/resume/verify/finalize` 现场重读 gate：`disabled` 机械阻断 live，`canary` 只供显式 V2 canary，`enabled` 是正常路由；任何状态都不得回退到 Codex v1。`disabled→canary` 绑定当前 controller release digest；`canary→enabled` 还必须给出同一 store 中、同一 release 完成动态 Revision 与完整 native receipt/Evidence 的 Certified Session ID。release digest 不匹配时 fail closed。旧 schema-v3 state 只转换一次：`shadow→disabled`、`opt-in→canary`、`default|legacy-freeze→enabled`；新写入只使用 schema-v4 和新词汇。

`capabilities` 输入包含闭世界 `probes` 与 `hard_prohibitions`。Authority 中的 Hard Prohibition 不是自然语言，而是 `workspace-write-boundary | network-deny | controller-state-isolation` 之一；prepare claim 必须满足 `rule===capability`，不能由调用方把任意规则映射到一个绿能力：

| capability | 等级 | 含义 |
|---|---|---|
| `workspace-write-boundary` | ENFORCED | 精确 `workspaceWrite` sandbox |
| `network-deny` | ENFORCED | sandbox `networkAccess=false` |
| `controller-state-isolation` | ENFORCED | state 在 executor 可写面之外 |
| `native-thread-readback` | DETECTED | 可事后读回，不能阻止 |
| `native-turn-readback` | DETECTED | 可事后发现，不能阻止 |

未知能力是 `UNAVAILABLE`。DETECTED、DECLARED、UNAVAILABLE 都不能满足 Hard Prohibition。语义性“不要部署”通常应编译为 Non-goal + 空 external effects；若用户明确要求它是机械硬禁令，而当前没有 ENFORCED mechanism，就停止启动。

## 2. Init、Preview、Confirm

完整输入直接编译，不运行 Grill。draft 的 `root_baseline.digest` 可先放合法占位 SHA-256；`init --capture-baseline true` 会在确认前由 controller 捕获真实 baseline、重新编译并把 snapshot 写入 CAS。

```text
init --state-root <controller-state> --input <draft.json> --capture-baseline true
preview --state-root <controller-state> --session-id <session-id>
confirm --state-root <controller-state> --session-id <session-id> --input <confirmation.json>
```

必须把 `preview.markdown` 完整展示给用户，并请其确认当前 `authorization_hash`。初始 Context dependency 会逐项显示 stable path 与 content SHA-256，且路径必须位于 Initial Active Boundary 内；不得把未展示的 target 外宿主路径注入执行器。confirmation 输入：

```json
{
  "authorization_hash": "<64-hex>",
  "thread_id": "<observed task id>",
  "message_ref": "<observed confirmation message>",
  "source": "codex-task",
  "confirmed_at": "<ISO-8601>"
}
```

用户的“直接跑”“按建议”不替代尚未展示的首次 Authorization 确认；确认后 Authority 内 Design Revision 不再重复整包确认。

## 3. Prepare 与 Launch

prepare 输入：

```json
{
  "attempt_id": "attempt-0001",
  "run_id": "run-0001",
  "nonce": "<32+ lowercase hex>",
  "expires_at": "<future ISO-8601>",
  "hard_prohibition_capabilities": [
    {"rule": "network-deny", "capability": "network-deny"}
  ]
}
```

```text
prepare --state-root <controller-state> --session-id <session-id> --input <prepare.json>
launch --state-root <controller-state> --session-id <session-id> \
  --run-id <run-id> --runtime-root <runtime-state> --deadline-ms <positive-ms>
```

prepare 由 controller 读回 root baseline、核当前 workspace、投影 immutable `AttemptManifest`、保存 Context Package/Projection Proof，并在一个写事务内检查/写入 LaunchIntent + root lease。`AttemptManifest.version=1` 只是私有 launcher ABI 的格式版本，不参与 runtime 路由。LaunchIntent 同时 MAC 绑定当前 controller release digest 与每个 target root 的 canonical path、device、inode；launch 在 dispatch 前重核版本和物理身份，再于同一 SQLite 事务把 pending intent 改为 `dispatching`、Session 改为 `Dispatching`。Active Boundary 不含 `write` 时 `thread/start` 必须使用 `read-only` sandbox；只有明确获授 `write` 才能使用 `workspace-write`。随后使用短 Goal 作为原生 objective，把完整 hash-bound Context Package 放进 `turn/start`。claim 后崩溃的同 run 重试只做 readback/reconcile，绝不再发副作用。

若 launch 返回 `reconciliation_required`，只运行 `reconcile` 或 `close`，不重发 launch。`CONTROL_PLANE_BYPASS` 不能自动洗成受控执行。

## 4. Verify、Revision 与下一 Attempt

候选出现后运行：

```text
verify --state-root <controller-state> --session-id <session-id> --attempt-id <attempt-id> \
  --run-id <run-id> --runtime-root <runtime-state>
```

当前 app-server 的 `turn/start` 响应 ID 与 `thread/read` 持久化 ID 可能不同，不能把二者强行视为同一个字段，也不能把任意 readback turn 洗入授权。LaunchReceipt v2 要求 controller 新建 thread 时读取到空 turn 集，在待发送文本中加入随机 256-bit `Controller Turn Correlation`，保存响应 ID 与 exact text SHA-256；运行结束后的首次 `thread/read(includeTurns=true)` 必须在同一 thread 上精确出现一个持久化 turn，且其中唯一 user message 的文本哈希必须核回 `turn_input_sha256`，才把该 ID 写入严格单元素的 `turn_id/authorized_turn_ids`。这才形成 request-to-persisted-input 加 `0→1` 的联合因果栅栏；只满足集合基数而输入不同、初始非空、零个或多于一个 turn、后续或 finalize 前后的任何 ID/输入变化都持久化为 `CONTROL_PLANE_BYPASS`，readback 不可归因则进入 `ReconciliationRequired`。随后 controller 在 default-deny Seatbelt 中执行 active Conditions：只读显式系统 runtime 依赖与 target roots、唯一可写 verifier 临时目录、无网络、最小环境、有界进程/CPU/文件资源，不能检查或 signal 宿主进程；启动使用结构化 argv 与 `shell:false`，Condition 仍可显式声明 `/bin/sh -c`，但不会发生隐式 shell 拼接。Evidence 绑定 root baseline、当前 context、runtime version、projection、snapshot 与 Attempt。

verify 红，或 Candidate 阶段的新 reviewer 发现 Authority 内缺口时，把 controller 事实编译为封闭 typed operation，调用 `revise`；revision 输入只有 `operation`，不接受调用方提供的 `controller_facts` 布尔值。`auto_apply` 后先 `close` 被取代 Attempt，释放它的 target-root lease，再用新的 `attempt_id/run_id/nonce` 调 `resume`；GoalSession 层的 resume 是新 immutable Attempt，不复用旧 candidate：

```text
revise --state-root <controller-state> --session-id <session-id> --input <revision.json>
close --state-root <controller-state> --session-id <session-id> \
  --run-id <prior-run-id> --runtime-root <runtime-state>
resume --state-root <controller-state> --session-id <session-id> \
  --runtime-root <runtime-state> --input <next-attempt.json>
```

`ADD_CONDITION`、`ADD_AND_VERIFIER` 只能 byte-preserve 原 Conditions 并追加一个唯一、closed-world、Authority 内 Condition；结构化加强、controller 实读 bytes 的 Context refresh、包络内 Boundary 调整不重新确认。`maximum_budget:null` 表示尚未授予预算；显式预算只接受正数，`0` 不代表“无预算”也不进入投影。`null→有限值` 是需要新 hash 的 Authority 扩大，已有有限值不能用 `null` 删除。越出 Maximum Authority 的 Boundary 直接拒绝，调用方必须显式提交 `EXPAND_AUTHORITY`；它追加 hash-chained AuthorityRevision 后进入再授权，旧 hash 确认无效。`REPLACE_EQUIVALENT_VERIFIER` 与 `CONTROLLER_CORRECTION` 在独立 proof API 落地前拒绝；`WEAKEN_CONDITION` 与 `CHANGE_GOAL` 创建 successor；`UNCLASSIFIED` fail closed。

## 5. Finalize、Reconcile、Close

只有 verify 返回 `completion.level="certified"` 才允许：

```text
finalize --state-root <controller-state> --session-id <session-id> \
  --run-id <run-id> --runtime-root <runtime-state>
close --state-root <controller-state> --session-id <session-id> \
  --run-id <run-id> --runtime-root <runtime-state>
```

finalize 在任何 terminal mutation 前、goal-set/get 后各执行一次 `thread/read(includeTurns=true)` turn fence；两次都只能看见 LaunchReceipt 授权的 turn，否则持久化旁路并进入 `ReconciliationRequired`，不得 set Complete。通过 fence 后还必须验证 controller 写入的 goal-set receipt 和独立原始 goal-get readback，成功后才把 Session 置 Complete 并释放 root lease。native terminal report 会形成 Rejected Attempt + Blocked Session；controller-owned close 只有在 native cleanup 明确 `cleanupComplete=true` 且 `runtimeQuiesced=true` 后才释放 controller root lease、关闭 intent 并恢复 Ready。foreign live runtime lease、cleanup 拒绝或失败都会保留 controller lease、将 intent 标为 `cleanup_failed`，Session 进入/保持 `ReconciliationRequired`。不能用退出码替代 JSON 中的 attribution、reasons、turn fence 与 cleanup 字段。

恢复只运行：

```text
reconcile --state-root <controller-state> --session-id <session-id> \
  --run-id <run-id> --runtime-root <runtime-state>
```

顺序固定为 event/blob integrity → lease → native readback → workspace/root baseline → Evidence dependencies。无法证明请求未送达时保持 ReconciliationRequired，绝不自动创建第二个 Turn。

## 6. V1 单向迁移

旧 v1 contract 只有在用户明确迁移时运行 `migrate-v1`。迁移输入保存为 immutable provenance，输出是 `AwaitingConfirmation` 的 V2 Draft；必须重新展示并确认 Goal + Authority。缺原始 baseline 时标记 `migrated_at_current_state`，只认证迁移之后的修改；不得把历史确认、runtime state 或完成证据伪造成 V2 Receipt，也不得给迁移前状态补发 Certified Complete。迁移后只能进入新的 V2 Attempt，不存在 v1 resume。
