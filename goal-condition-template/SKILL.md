---
name: goal-condition
description: 当用户要求把任务、边界包或已有完成条件编译成可确认、可验证的 Claude Code 或 Codex goal 运行契约时使用。
---

# goal-condition

本 skill 是平台无关的 router/compiler。它把输入编译为同一份 run contract，交给所选 runtime adapter 启动，并由当前主会话独立终验。它不复制平台 CLI 帮助，不保存项目私有锚点，也不递归创建另一个 goal。

唯一合法顺序如下，催促、已有 launcher 或表面成功都不能跳步：

```text
Classify → Compile → Validate → Preview → Confirm(hash)
→ Preflight → Launch(adapter) → Postflight → Close
```

## Classify

先把输入分为任务描述、boundary package 或已有 run contract。任务描述先用 boundary-design 补齐边界；boundary package 直接编译；已有 contract 仍须重新校验和预览。

一个 contract 只能有一个 single objective。输入若含多个可独立完成的目标，必须让用户选择一个；不得静默合并，也不得在本 skill 内启动子 goal 来拆分。

## Compile

按 [run contract 字段与编译规则](references/run-contract.md) 生成 JSON，并读取安装实例的 [项目 profile](references/anchors-and-rules.md)。落盘文件必须是 `canonicalJson(parsed)` 生成的 canonical JSON bytes；它是后续确认、snapshot 与 launch 共用的唯一权威 artifact。所有事实性上下文必须来自 content-bound stable context：`context_sources` 的每项都含唯一 `id`、非临时绝对 `path` 与该文件 bytes 的小写 SHA-256 `sha256`；禁止依赖“上文”或仅存在于会话压缩前的内容。

编译结果必须无损包含完整 Goal condition package：

| 输入语义 | contract 字段 |
|---|---|
| 唯一目标 | `objective` |
| 稳定上下文与目标根 | `context_sources`、`target_roots` |
| 判断标准 | `judgment_criteria` |
| 成功标准与验收物 | `success_criteria` |
| 边界及其执行强度 | `constraints`，`physical` 或 `audit_only` |
| 允许的变更 | `allowed_mutations.files/git/external` |
| 启动前与结束后核验 | `preflight`、`postflight` |
| 用户明确给出的可选资源限制 | `budget.user_provided=true` |

`physical` 只用于已有可执行 mechanism 且有 verifier 的约束。无法物理拦截的约束必须写成 `audit_only`，不得宣称为 sandbox、权限或代理层面的物理保证。预算只有在用户明确给出时才写入；不得推测默认 token、时间或费用；`budget.max_turns` 是轮数，只接受正整数。

每个 runtime 的物理面各只有一处，编译期就得照它选 enforcement，否则产出的是注定被 launch 前置闸拒绝的 contract：`runtime="claude"` **没有**面向用户约束的物理面（adapter 生成的 deny 只护它自己的 hook 脚本与 state 目录），该 runtime 的约束一律写 `audit_only`；`runtime="codex"` 只有 `--sandbox workspace-write` 一处，`mechanism` 指不到它的（网络 proxy、只读凭证等）同样只能写 `audit_only`。

## Validate

从本 skill 根目录调用 [validator](scripts/validate-contract.mjs)，只传 contract 文件：

```text
node scripts/validate-contract.mjs --contract <contract-file> --preview
```

任何 diagnostic 都必须保留安全的字段位置、observed 指纹、expected 与 next step；用户控制的 key、ID、路径片段、值和 parser message 不得原样回显。`readContract` 会先做无 BOM 的 strict UTF-8、JSON 与 `canonicalJson(parsed)` byte-identical 检查；`CONTRACT_JSON_INVALID`、`CONTRACT_BOM_FORBIDDEN`、`CONTRACT_UTF8_INVALID`、`CONTRACT_BYTES_NONCANONICAL` 的 observed 只能是 raw SHA-256 与 numeric byte length。即使解析后的对象相同，只要空白、key 顺序或尾随换行不同，也会 fail closed。校验失败即停止，不得进入 Preview 之后的状态。

## Preview 与 Confirm(hash)

向用户展示 validator 生成的完整 preview，而不是摘要。可读章节之后必须原样附 authoritative canonical JSON，完整覆盖 version、runtime、context、target roots、budget 和所有 nested preflight/postflight 字段；SHA-256 对这段落盘 bytes 计算。

请用户明确确认当前 hash。只有针对该 canonical artifact hash 的确认有效。任何文件字节编辑都会让 artifact 失去 launch 资格：非 canonical 变体先被拒绝；重新 canonicalize 后也必须重新 Validate、Preview、Confirm，不得用“语义对象没变”沿用旧确认。用户说“直接跑”或“赶时间”不等于确认一个尚未展示的 hash。

## Preflight

确认后才按 [snapshot 协议](references/run-contract.md#preflight-与可信-baseline-digest) capture baseline。capture 必须核对每个 context 的 bytes、物理路径与 mode，成功写出完整 Git/file snapshot，并把输出的 `baseline_digest` 存入 baseline 文件之外的可信编排状态。主会话再建立绑定 confirmed hash、可信 digest 与 controller-issued run ID 的 `runBinding`，并提交同一 binding 的 controller-owned `preflightEvidence`；缺失、失败、格式错误或不匹配都禁止 launch。

任一 preflight 失败都不得启动 adapter。外部动作若没有可验证快照或 verifier，只能保持 `audit_only`；需要物理保证时应停下，等待只读凭证、proxy、sandbox 或 deny mechanism 就绪。

## Launch(adapter)

仅把已确认 hash 对应的 contract 交给匹配 runtime 的 adapter：

- `runtime="claude"`：读取 [Claude adapter](references/adapters/claude.md)。
- `runtime="codex"`：读取 [Codex adapter](references/adapters/codex.md)。

adapter 不得补写目标、预算或权限承诺。它只能消费已确认 contract 与可信 preflight 结果；协议文档与测试本身不调用真实 runtime 工具；真实启动由 `scripts/launch.mjs` 作为唯一执行豁口承担。

## Postflight

runtime 报告候选终态后，由启动它的主会话执行独立 postflight。执行会话不得自证：主会话须重跑结构化 verifier，并用 capture 阶段保存在可信编排状态中的 `baseline_digest` 验证 baseline 后再比较当前边界。Claude 与 Codex 都必须提交绑定同一 `runBinding` 的 controller-owned `postflightEvidence`；Claude 的 exact terminal result 通过后才能 complete。Codex 候选态必须是 `ready_for_postflight`，其后由主会话把 `thread/goal/set` receipt 与原始 `thread/goal/get` readback 分别写入独立 controller-owned 通道。Codex 顺序固定为 `postflight` → `finalize_runtime` → `verify_runtime` → complete，具体信任边界见各 adapter。

产物缺失、命令结果不符、未授权 mutation、baseline digest 不匹配、runtime error、permission denial 或 remaining work 任一存在，都必须 fail closed。不得用 runtime 的单个 success 字段替代独立核验。

fail closed 不等于就此停机：红项必须先过 `classifyPostflightRed` 分流。可续类（命令失败、产物缺失）走 adapter 的 resume 把红项 diagnostic 馈回执行体；终局类（边界违规、git/权限类，以及任何未知 code）才报告停机。状态机对这两类红 postflight 返回的都是 `reject`，分流这一步在它之外，必须由主会话自己调——否则 resume 永远不会被发起。馈回的 diagnostic 只能由 contract 声明的事实与控制器自己的判定构成，不得包含执行体产出的字节（各 adapter 的信任边界写明形状）。

## Close

把 validation、confirmed hash、preflight、adapter 终态与 postflight 结果交给既有状态机。只有它返回 `complete` 才可关闭。`reject` 先按上一节分流：可续类续跑，别把它读成收工；其余状态按 diagnostic 报告实际差异和下一步，不得改写为完成。
