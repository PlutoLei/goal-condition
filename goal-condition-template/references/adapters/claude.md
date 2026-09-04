# Claude Code adapter

此 adapter 只处理 `runtime="claude"` 的已确认 run contract。字段语义、hash 与 snapshot 握手见 [run-contract reference](../run-contract.md)。它不修改 contract，也不替其他 runtime 解释状态。

## Launch 前置条件

主会话必须已经完成 canonical artifact 的 byte-identical 检查、Validate、完整 Preview、当前 hash 的明确确认以及 Preflight。Capture 输出的 `baseline_digest` 必须保存在 baseline 文件之外的可信编排状态。随后主会话建立 controller-owned `runBinding`，并把独立 preflight 结果绑定到同一值；缺少任一项都不 launch：

```json
{
  "runBinding": {
    "contractHash": "<confirmed contract hash>",
    "baselineDigest": "<trusted baseline digest>",
    "runId": "<controller-issued run id>"
  },
  "preflightEvidence": {
    "ok": true,
    "reasons": [],
    "binding": {
      "contractHash": "<confirmed contract hash>",
      "baselineDigest": "<trusted baseline digest>",
      "runId": "<controller-issued run id>"
    }
  }
}
```

`preflightEvidence` 是 closed-world controller channel，不能从执行会话或 launch 输出反序列化得到。失败必须用 `ok=false` 和非空安全 reasons 表达，并停止 launch。

普通 Claude launch 之前还有一道 machine-level capability gate。Controller 从
`<controller-state-root>/runtime-certifications/claude.json` 读取 mode `0600` 的闭世界状态；父目录必须是
真实的 mode `0700` 目录。只有 `mode="certified"`，并且 receipt 与当前已验证 source identity、Claude
runtime-surface digest、CLI version、OS、arch、非秘密 `auth_mode` 及 operator 管理的 opaque
`auth_context_id` 全部精确一致，才允许进入 attempt 生命周期。任何缺失、字段漂移、source
commit/manifest drift 或五项 canary condition 不完整都有效降级为 Candidate；旧 receipt 保留作审计，
不因有效态降级而被覆盖。

这道闸是 `runClaudeAttempt` 的最外层检查：`CLAUDE_CAPABILITY_UNCERTIFIED` 发生时不创建
`attempts/`、不改 `settings.json`、不 claim `thread.json`、不取得 `claude-attempt.lock`、不 spawn。
禁止 `--force`、`skip` 或任意 contract 复用 Candidate 执行豁口；唯一豁口由固定认证命令拥有。
Codex runner 不读取这份 Claude state。认证身份只保存 `claude_ai` / `api_key` 枚举与 opaque context ID，
不保存邮箱、组织、subscription、key hash，也不从 credential 派生 ID。

### 固定认证命令

Candidate 只能通过 `certify-claude-prepare` / `certify-claude-run` 进入执行面。prepare 接受当前
source、disposable target/state、`claude_ai|api_key`、opaque auth context ID 和 sentinel SHA-256，生成
唯一 fixed certification artifact；operator 还必须显式提供 `--max-turns`，Controller 不猜预算。artifact
以 mode `0600` 落盘，闭世界包含 source realpath + commit/manifest、runtime surface digest、auth mode/context、
disposable roots、sentinel、预算与固定 run contract，并打印完整 preview 与当前 hash；它不 launch。任一字段
变化都会改变 canonical artifact bytes/hash。`--source` 必须与实际执行 `launch.mjs` 的 release/checkout 根
完全相同，不能用 A 的 identity 给 B 的代码发 receipt。run 重新验证 Git checkout 或 external
manifest v2 source identity，重新编译并逐字核对 artifact，且必须收到刚展示的 exact hash；stale hash 与
任意 contract drift 都在 baseline capture、control lane 与 adapter lane 之前失败。

disposable target 由 operator/controller 预置为 clean Git root：`sentinel.input` 已提交且 bytes 匹配确认的
SHA-256，`.claude/settings.json` 已提交并对该 input 配置 ambient Read deny，`sentinel.output` 不存在。Controller
在 baseline 前重核 output 缺失，避免预存正确 bytes 冒充本轮写入；control 完成后、adapter 启动前再核一次，
避免 ambient hook/control 抢先产出正确 output 后把写入能力错误归给 adapter。control lane 允许 ambient project
settings 生效，并必须精确核到对 `sentinel.input` 的 `Read` 被 deny 规则拒绝；其他 tool/path denial 不算。拒绝的观测通道有两条：envelope 的 `permission_denials`（2.1.228 及之前的形态），或同一会话 transcript 里该 `Read` tool_use 的 tool_result（`is_error:true`，正文 "denied by your permission settings"）——2.1.260 实测（2026-09-04）deny 规则命中只走后一条，`permission_denials` 只剩「需要询问而在 `-p` 下被自动拒绝」的调用（例如工作目录之外的路径）。transcript 路径规则无稳定性承诺，读不到即无证据、按 candidate_rejected 处理，不当作 blocked。adapter lane 仍走标准
`prepareClaude`、flag settings、`--setting-sources ""`、claim/attempt/result 流程，只是固定认证入口可以在
Candidate 下调用。固定 contract 的 objective 把执行体的权限事实写进 prompt（只有 Read/Write 文件工具；不跑 shell、不调 MCP、不派子代理；任何被拒的工具调用都让 canary 失败）——2.1.260 实测执行体在没被告知时会先试 `cp` 被拒再改用 Write，输出正确而 `isolated-adapter-candidate` 红。随后 Controller 独立验证 output hash、本轮 hook-run 增量、postflight 与 baseline compare；
历史 hook log 行不得继承为当前证据。

receipt 仅在五项 `ambient-deny-control`、`isolated-adapter-candidate`、`sentinel-output`、
`flag-settings-hook`、`baseline-preserved` 全绿时原子发布；只保存 canonical evidence aggregate/result/report
hash，不保存 prompt、transcript、sentinel/settings bytes 或身份信息。API 429、subscription/session limit、
网络和 provider failure（包括非零进程返回的结构化 provider envelope）在四字段 Candidate 落盘前提取为
不含 result/transcript 的 controller blocker，一律报告 `blocked`，不覆盖旧 receipt，
也不伪装成 `candidate_rejected`。发布路径不接受 run 阶段自由参数，只能由已确认、与 source/target 物理隔离
的 state root 派生为 `runtime-certifications/claude.json`。

## 启动姿态与 Stop hook

**弃用 `/goal`**：`/goal` 是 session-scoped 的 prompt-based Stop hook 包装，每轮由默认小模型（Haiku，弱判官）判条件是否满足；condition 上限 4000 字符，压缩长 contract 会丢语义；一旦 settings 出现 `disableAllHooks`（或 `allowManagedHooksOnly`），`/goal` 整体失效、无降级路径。记名保留、明确弃用，不再作为本 adapter 的启动姿态。改用裸 `claude -p` 直接起会话，配合控制器生成的 command 型 Stop hook 自建确定性续轮自检；协议核心（contract 格式、hash、证据通道）不受影响。

把已确认 contract 的 `objective` 与必要的 criteria、constraints、allowed mutations、成功证据编译成一个自含 prompt。内容先写入权限受控的普通文件，再由启动器读取文件 bytes，以单一 argv 参数交给 `claude -p`；禁止把 prompt 拼进 shell 字符串，也禁止通过 shell quoting 传递特殊字符。达标判定不依赖这段 prompt 里的自然语言承诺——它由下方的 Stop hook 以确定性命令兜底。

**会话身份由控制器预派（claim-before-dispatch）**：launch 的 argv 恒带 `--session-id <uuid>`，UUID 由启动器现场生成；resume 指针 `thread.json` 在 spawn 之前先写入并 fsync 同目录私有 inode，再以 hard-link no-replace 原子发布，闭世界记录 `schemaVersion=2`、session/prompt/transcript 坐标、全量 canonical target/read roots，以及每根目录的 launch-time device/inode 十进制字符串。失败清理只删私有名，不 unlink 可能属于后来者的公开 pathname。指针读走 descriptor + `O_NOFOLLOW`，且只接受单链接 regular file 与精确九字段形状；已有、损坏、不可读或 symlink/hardlink 指针都 fail closed，必须显式恢复，绝不覆写后另起会话。resume 同时核 canonical path 与 device/inode，所以删除后在同一路径重建目录也不能复活旧会话。

每个 state 目录另有一个 `claude-attempt.lock` 独占 lease，从 attempt 专属 `settings.json` 首次落盘前开始，覆盖 validation、占号、pointer claim/rebind、executor 整轮运行与 result 落盘；并发 launch/resume 不能替换活动轮次的 settings，也不能各占一个更高序号。占号之后、调用执行器之前的失败只在持有该 lease 时回滚本进程以 inode identity 证明所有权的 pointer 和最高 attempt slot，预算因此只统计真实 dispatch。max-turns 硬停、进程崩溃、stdout 不可解析等已经 dispatch 的终局形态保留 pointer 与 attempt，「预算耗尽走 resume 续跑」不再依赖成功形态 envelope。控制器崩溃可能留下 lease；PID 存活判断与 pathname unlink 无法组成原子所有权证明，因此不自动回收。须先 reconcile 后显式恢复，或换新的 `--controller`。

CLI 对重复 UUID 明确拒绝（实测），预派不会静默串台。终局侧核 envelope 回显的 `session_id` 必须等于控制器持有值。`--session-id` 与 `--setting-sources` 的可用性均由 prepare 从 `claude --help` 的精确长选项 token 探测。仅有旧 `probes.json`、且尚未 claim 会话时可重跑 prepare；六字段 legacy pointer 已代表 in-flight/历史会话，重跑 prepare 不会也不应伪造缺失 identity，必须用原 adapter readback/reconcile 后换 fresh controller state。

任务级自动授权由已确认 contract 的可选 `execution_permissions` 编译进独立 `--settings`：显式 `bash_prefixes` 生成前缀 `Bash(<prefix>:*)`，另生成 WebFetch domain、Skill 与额外目录。**postflight verifier 不进 Bash allow-list**：argv 是 execFile 语义、Bash specifier 是 shell 字符串语义，两者之间没有可靠编码——`argv[0]` 通配会让 `git diff` 顺带授权 `git push`、`bash -lc` 授权任意 shell；整条 argv 拼接则既可能在 shell 语义下多授权一条命令（`['printf','%s','a; touch x']`），又可能产出与真实 tokenize 永不匹配的死规则（`['git','diff','a b.txt']`）。verifier 的执行不依赖这条通道（Stop hook 用 `execFileSync` 跑它，不经 claude 权限）；执行体要自行运行 verifier 由作者显式 `bash_prefixes` 声明。未知字段、Codex runtime 误用和无法安全放进权限 DSL 的 prefix/domain/skill 都在 Validate 阶段红。编译器和 launch gate 对实际进入 DSL 的 Bash/WebFetch/Skill、state root 与 hook path 共用同一表示性规则；`PermissionSpecifierError` 只包装这类预期诊断，其他 `TypeError` 原样上浮。target roots 与 `additional_read_roots` 仅作为 cwd / `additionalDirectories` 的 JSON 值，不进入无转义的 `Tool(specifier)` DSL，因此合法文件系统路径不会因括号被误拒。

全部执行体可达根（target roots 与 `additional_read_roots`）都不得与 controller state 目录有任何包含关系；否则同 uid 执行器能直接读取 `hook-env.json` 和控制器证据，Edit deny 不能提供读隔离。检查使用 component-safe path containment，`/` 也会正确命中。Claude 的实际 cwd 使用 canonical 首 root；控制器在 spawn 前复核全部授权根的 device/inode，pointer 同时绑定 canonical path 与 launch-time identity，resume 任一处 path 或 identity 漂移都拒绝。

**环境 settings 不再进入受控运行**：launch/resume 固定带 `--setting-sources ""`，关闭 user/project/local 三类来源；Controller 的 `--settings` 仍以 `flagSettings` 加载，企业 `policySettings` 仍按 Claude 的管理边界生效。这样预存 `.claude/settings*.json` 即使含扩权 permissions 也不在 effective allow-list 中，删除了无法封闭的 scan-to-open TOCTOU、git-root discovery 和不安全文件读取面。代价是受控运行不继承用户/项目的 hooks、model 偏好等环境配置；需要的能力必须显式进入 contract 或 Controller settings。

本实现不使用 `--disallowedTools` 作为第二套权限真值源；并存 CLI deny 与 contract-compiled settings 会制造两份可漂移的授权表。若未来引入，只能由同一份已确认字段投影生成，并纳入同一前置闸。

这仍然不是通用 `physical` constraint 编译器：allow 是免询问授权，Controller state 的 deny 保护控制器机件，`additionalDirectories` 在 `acceptEdits` 下也不是只读沙箱；任意业务约束没有对应的 OS enforcement。因此 claude runtime 的 constraint 仍一律写 `audit_only`，实际 mutation 由独立 baseline compare 判定。确需物理保证，须先提供可 fault-inject 的 sandbox、proxy 或只读凭证，或改用有物理面的 runtime。2026-08-12 的旧 F-B1 canary 仍证明当前 CLI 的目录级 Edit/Write deny 行为，但 target-local settings deny 已被 2026-08-13 的 setting-source isolation 取代；新版 release canary 应证明 ambient project permissions 不加载、Controller flag settings 仍加载，并继续以 baseline compare 裁决 mutation。

### 启动姿态里的四个权限事实

- **`--permission-mode acceptEdits`**：`launchSpec`/`resumeSpec` 固定带这个 flag。除生成的 deny 外，工作目录与 additionalDirectories 内的编辑不会逐次询问；`permissions.allow` 还会免询问批准声明的 Bash/WebFetch/Skill。无人值守需要这层授权，但它不是验收或通用隔离，不能靠“模型会先问一句”成立约束。
- **`--max-turns`**：固定带上。无显式预算时取 `DEFAULT_MAX_TURNS=50`；用户确认的 `budget.max_turns` 原样进入 argv，可提高到 `MAX_TURNS_CEILING=200`，超过 200 在占号与 spawn 前红，不静默改写成 200。它与 Stop hook 的 `MAX_HOOK_BLOCKS` 是两层不同的闸：前者硬停单次 attempt，后者决定 hook 还愿不愿意把未达标的会话续下去。
- **`--strict-mcp-config`（且不带 `--mcp-config`）**：`launchSpec`/`resumeSpec` 固定带上，执行体不加载任何 MCP server（用户级、项目级、plugin 带来的都不加载）。2026-09-04 真实 run 实测：acceptEdits 下执行体调用一个 plugin 的 MCP 读工具，被拒一次即记入 `permission_denials`，整 run 按边界违规判终局——而那次调用本身没有任何越界意图。MCP 工具面从执行体里移除，比在 prompt 里写「不要调 MCP」可靠。
- **`--disallowedTools Agent Task`**：固定带上，执行体不派子代理（`Agent` 是现名，`Task` 是旧名，一起禁）。同一次实测：执行体派了一个只读子代理去读文档，子代理用 `/System/Volumes/Data` 前缀的 firmlink 路径读 target root 内的文件，CLI 判在工作目录之外，13 次拒绝全部记到主 envelope 的 `permission_denials`。单执行体也是本 adapter 的问责模型——一份 transcript、一份 `permission_denials`、一个 Stop hook。这两条与 `acceptEdits` 一样只是 CLI 声明的姿态，未做 fault injection，不据此把任何 contract constraint 升为 `physical`；`EXECUTOR_TOOL_POSTURE` 是 argv 的最后一段，`--disallowedTools` 是变长参数，放在别的 flag 前面会把它们吞成工具名。

prompt 编译时把这两条也写给执行体（「不得调用 MCP 工具、不得派子代理、只用 contract `target_roots` 给出的路径形式读写文件」）：姿态挡住的是工具，写明是为了执行体不把轮数烧在反复尝试上。任何被拒的工具调用——哪怕是读——都让 `permission_denials` 非空而终局，这是 `acceptEdits` 面下唯一的越界信号，不能为「良性」的拒绝开口子。

max-turns 的特殊恢复路由不只看 19-key 全集，还要求实测 discriminator 同时成立：`type=result`、`subtype=error_max_turns`、`is_error=true`、`terminal_reason=max_turns`。key 对但取值不对仍按协议漂移落红，不会错误压低 hook 期望或标成可续。

### Stop hook 契约

- **生成**：launch 前由控制器从已确认 contract 的 `postflight` command entries 逐条取 `id`/`cwd`/`argv` 投影生成脚本——不解释、不改写命令语义，零 schema 改动。脚本落 controller state 目录（例如 `~/.local/state/goal-condition/controllers/<name>/<contract-hash>/`），`--settings` 对该脚本路径与整个 state 目录设 **Edit** deny。
- **达标判定**：hook 逐条执行 postflight command，多条红收集不抛出——某条非零退出即记为红；这同时钉死独立 postflight 的红判据（command entry 不带 `expected` 字段，红=非零退出）。全绿即候选达标，继续 block 表示尚未达标。
- **block 协议**：hook 向 stdout 写 JSON decision `{"decision":"block","reason":"..."}` 并以 exit 0 退出——不是 exit code 2；放行时不写 decision，同样 exit 0。`reason` 措辞必须与 objective 兼容，只能是「未达标，请补 X」式陈述，不得与任务目标语义冲突——冲突会让模型遵从 objective 罢工、静默 block 到预算耗尽，形成死循环。
- **预算放行**：block 次数达到上限（`MAX_HOOK_BLOCKS`，默认 8，contract 的 `budget.max_turns` 更严时取较小值）或运行时长超过 `budget.max_minutes` 折算的墙钟预算，hook 一律放行停机，候选态如实标「未达标」，不得无限 block。
- **运行留痕**：hook 每次执行向 state 目录追加一条记录（时间戳、红项清单、decision）。控制器校验「累计 `hookRuns` ≥ 累计 `hookExpected=true` 的候选轮次」，把 hook 静默缺席（resume 未继承 `--settings`、hook 被绕过删除）变成可验证的红，同时排除不会触发 Stop 事件的 max-turns 硬停。对账字段从 launch 返回体取：每个结果都带 `attemptNumber` 与 `hookRuns`（该刻的留痕行数），候选结果另带 `hookExpected`；主会话不必自己读 state 文件。`attemptNumber=null` 表示调用被前置闸挡在 spawn 之前、没有占用轮次；`hookExpected=false` 表示本轮确实 spawn 过，但终局机制不产生 Stop 事件。二者都不是字段缺失。
- **定位声明**：hook 是续轮驱动器，不是验收。它的判定结论不进入任何 controller 证据通道；hook 全绿仍可能被控制器独立 postflight 推翻，例如越权 mutation 只有 baseline compare 能看见。
- **副作用告诫**：hook 命令集应限定为无写副作用的子集；如确有产物写入，必须把产物路径纳入 contract 的 `allowed_mutations` 并在 Preview 里显式列出，否则可能落进 target root、被误判为不可续的边界违规。

### hook 保护定性

`--settings` 对 hook 脚本和整个 state 目录设 Edit deny；实测显示 controller-path deny 对简单 Bash 重定向同样有效，被真实 `permission_denials` 拦下——比早先「仅观测性防线」的假设更强。但 deny 的精确上限（语义级路径解析 vs 字面文本匹配）仍 INCONCLUSIVE，不宣称完全物理保证。路径必须写成 realpath 规范形。target-local settings 不再靠 deny 保护，而是通过 `--setting-sources ""` 从加载面移除；发布前 canary 分别验证 source isolation 与 Controller flag settings。

此文只规定 adapter 契约，不在文档或测试中调用真实 launcher。实际启动前仍要向用户展示准确 argv、目标目录和已确认 hash。

## launcher 退出码语义

`scripts/launch.mjs` 的退出码只是给编排器的粗信号；**成败的权威判据永远是 stdout 的报告体**（`outcome` 与 `reasons`）。四格互不重叠：

| 退出码 | 含义 | stdout |
|---|---|---|
| 0 | 命令跑完并产出它声明的结果；`launch`/`resume` 特指 `outcome="candidate"` | 报告体 JSON |
| 1 | 进程级失败：Claude capability 未认证、contract / prompt / diagnostics 文件读不出**或红项清单不合形状**、attempt 号没占上（配额已耗尽 `ATTEMPT_LIMIT_EXCEEDED`，或并发下被别的进程抢先 `ATTEMPT_SLOT_TAKEN`）、flag 落在不支持的 runtime 上 | 空（诊断在 stderr） |
| 2 | usage 错误：未知子命令、缺必填 flag、重复或无值 flag | 空（usage 在 stderr） |
| 3 | `launch`/`resume` 返回 `outcome="terminal_report"`：被前置闸挡下没起飞，或起飞后判定终局 | 完整报告体 JSON，`reasons` 非空 |

3 与 0 分开是刻意的：二者此前同为 0，「根本没起飞」因此对只读退出码的编排器完全不可见。读退出码判成败的编排器至少要能 fail closed；但它仍不能替代把 `runtimeResult` 原样喂给 `nextAction` 这一步——终局报告不是候选，只有状态机能给出下一步。

`snapshot.mjs` 的 `verify` 判否时同样把完整报告体打到 stdout、但 `exitCode` 走的是 1，与上表把「完整报告体」钉在 3、把 1 定义成「stdout 空」不是同一套约定——上表已显式限定 `scripts/launch.mjs`，跨脚本编排退出码时不要混用。

## Runtime 终态

不得只看 `subtype`。Adapter 向公共状态机提交的结果必须先通过实测 key 集全等校验，未知 key 或缺失 key 一律 fail closed，不静默丢弃。锚有**两个**，按 `subtype` 二选一、互斥不重叠：

- `subtype` 不是 `error_max_turns` → 24-key 成功锚（`CLAUDE_RESULT_KEYS`：2.1.223 实测 21 key，2.1.228 复核未漂，2026-09-04 在 2.1.260 的真实 run 上重锚为 24 key，新增 `first_content_frame_ms`、`queued_turn_count`、`subagent_stats`——那次 run 的执行体已 `subtype:success / terminal_reason:completed`，仍因 3 个未知 key 被判 `terminal_report`，这正是直检的设计方向，代价是每次漂移都要人核对新 envelope、改表、加 fixture、抬下限）；
- `subtype === "error_max_turns"` → 19-key error 锚（`CLAUDE_ERROR_MAX_TURNS_KEYS`：2.1.226 真实 run 与 2.1.228 spike 逐 key 一致的 17 key，2026-09-04 在 2.1.260 用 `--max-turns 1` 硬停实测重锚为 19 key，多 `queued_turn_count`、`subagent_stats`；比成功锚少 `api_error_status`/`result`/`time_to_request_ms`/`ttft_ms`/`ttft_stream_ms`/`first_content_frame_ms`、多 `errors`）；全集相等后仍须满足上面的四值 discriminator，才产生 `budgetExhausted`。

第二锚过闸的结果是**未达标候选而不是协议漂移**——「没干完」和「envelope 变形」是两类事，单锚时代它们同落 malformed，把最需要续跑的形态（预算耗尽）封死在 resume 之外。launch 返回体以 `budgetExhausted: true` 标注这类候选（报告体字段，**不进** `candidate`——candidate 恒 4 字段，`workflow.mjs` 的 claudeTerminalState 做闭世界形状检查），控制器据此走「未达标可续」分流。其他 error subtype（如 `error_during_execution`）没有实测锚，一律按成功锚落红：只为实测过的形态建锚。

通过后投影出以下 4 个字段参与判定：

| 字段 | 成功条件 |
|---|---|
| `subtype` | 精确为 `success` |
| `is_error` | 精确为 `false` |
| `terminal_reason` | 精确为 `completed` |
| `permission_denials` | 必须是空数组 |

`terminal_reason:"completed"` 这一取值是 `2.1.223` 实测锚定、`2.1.260` 复核不变；⚠️ SDK 文档列出的 `terminal_reason` 取值集并不包含 `completed`（列的是 `success`/`max_turns_reached` 等），字段取值存在文档与实现的漂移，exact-match 判定必须钉住实测版本的取值。

### 版本闸：下限，不是白名单

版本闸只排除已知过旧的版本：launch 前置闸拒绝低于 `CLAUDE_VERSION_FLOOR`（= `2.1.260`，两个锚在 2026-09-04 重新实测的版本；此前为 `2.1.223`）的 claude，等于或高于一律放行。下限随锚一起抬：新锚要求新 key 都在，更旧的 claude 无论如何都会在直检处落红，下限低于锚的实测版本只是把同一个拒绝换个措辞。envelope 的**形状**漂移由上面那道 24-key 全集校验直接兜住——注意它**只覆盖 key 集**，字段取值不在其内（见下面「放松之后丢了什么」第 1 条）。

判定细节：版本串按 major/minor/patch 逐段**数值**比较（`2.1.9` 低于 `2.1.10`，字符串字典序在这里会翻车）；解析器锚定串首，接受版本号打头的形态（`2.1.223`、`2.1.223 (Claude Code)`），版本号不在串首的（`Claude Code 2.1.225`）会被**拒**；解析不出来一律拒，不当作放行。生产路径上这个解析器拿不到 `--version` 的原样输出——采集器（`scripts/launch.mjs`）先用无锚定正则抽出三段数字再写进 `probes.json`，`parseVersion` 是那一步之后的兜底，别把采集器那一步省掉，省掉之后前缀形态的输出会变成「读不出来 → 拒」的可用性 bug。预发布号是**已知边界**：`2.1.223-beta.1` 在 semver 里低于 `2.1.223`，这里却放行；改 `parseVersion` 没用，采集器的正则已经把预发布后缀丢掉了，真要拦得改采集器——claude `--version` 目前不发预发布标签，暂记为已知边界。

之所以不是精确 allowlist：版本号是**代理指标**，它想挡的 result envelope 形状漂移已经有**直接检查**在管。于是两种情形都对 allowlist 不利——envelope 没变的新版本被 allowlist 拦下是纯误杀；envelope 的 key 集真变了的新版本，24-key 直检照样红，诊断还更精确（reason 会指出「可能是 claude 升版导致 envelope 漂移，核对新版本的 result envelope 后更新 `CLAUDE_RESULT_KEYS`」，按隐私纪律只给计数、不回显 key 名）。代理指标严于直接指标，换来的代价是 claude 每隔几天升一次版就「工具不可用」——而那种闸的真实结局是有人把它注释掉，那才是最坏的。

#### 放松之后丢了什么

allowlist 原本顺带覆盖、而直检覆盖不到的有三处。它们**不都是可观测的**，别用可观测性声明把缺口盖住。

1. **取值锚没有直检兜底。** 24-key 全集校验判的是 **key 集**；`terminal_reason:"completed"` 是**取值**锚，取值由 `workflow.mjs` 的 exact-match 判定（不等于 `completed` 即红），而那个取值是 `2.1.223` 实测钉下来的，没有任何检查去核对它在新版本里还是不是同一个意思。两个方向后果不同：取值被**改名** → exact-match 全红，方向是 fail-closed，但诊断退化成「Claude terminal_reason must be completed」，读起来像「模型没干完活」，操作员可能把续跑配额烧在一个幻觉上；取值语义**变宽**（例如新版本把 `max_turns_reached` 也归进 `completed`）→ 形状与取值两道检查都过，产出**假 candidate**。**升版后第一次 run 必须人工核对这个取值。**
2. **Stop hook 的 block 协议**（stdout 写 JSON decision、exit 0）。不是 envelope 形状，直检覆盖不到。可观测性要分开说：hook **本体被篡改**抓得住——每个 attempt 现场重新 lstat + 重算 hook 脚本 sha256（不信任 `probes.json` 的缓存值），与现场重新生成的期望值比对，篡改会在下一个 attempt 的前置闸落红；残留敞口是最后一个 attempt 内的篡改没有下一轮去查。但**协议漂移**抓不住：生成的脚本向 `hook-runs.jsonl` 追加留痕这一步在 decision 分支**之外无条件执行**，协议漂了（改回 exit 2、或换 JSON 形状）hook 照常运行、照常追加、`hookRuns` 照常涨，只是 claude 不再理会 block。它的真实表现是「会话没续、postflight 红」，与「任务本来就没做完」不可区分——**弱可观测，没有专门指向病因的信号**。（`hookRuns` 不涨描述的是另一种失效：hook **缺席**，resume 没继承 `--settings` 或 hook 被删。两者不是一回事。）
3. **`--settings` deny 的防护面。** 同样不是 envelope 形状，而且这里**没有可用的观测量**：`permission_denials` 必须为空才算成功，deny 面失效产出的也是空数组，与健康 run 逐字节相同——「deny 好使、没人尝试」和「deny 坏了、写进去了」在这个字段上不可区分；何况这条信号要求真有人去写受保护路径，正常 run 里根本不产生观测量。
4. **setting-source isolation 是权限确定性的直接边界。** Claude 2.1.229 的 `--setting-sources ""` 把 allowed sources 解析为空；runtime 仍固定加入 `flagSettings` 与 `policySettings`。因此不再依赖 project settings 的发现路径或文件扫描。升版时要重验的是空 source 的行为与 flag/policy 固定来源，而不是追逐新的 git-root discovery 规则。

还有一条要写明：第 2 条的证据 `hook-runs.jsonl` 就住在第 3 条的 deny 所保护的 state 目录里。deny 面若失效，执行器可以往里追加伪造行让「hook 运行次数 ≥ attempt 轮数」的对账凑数而 hook 从未真跑。**这两条不是互相独立的双保险，是一条守着另一条的证据。**

**放松之后真正的安全底是分层防御，不是可观测性。** 即便取值语义变宽产出假 candidate，下面「Postflight 与 Close」一节要求主会话**独立重跑** postflight command verifier 并调用 snapshot verify（传入可信编排状态保存的 `baseline_digest`）之后才能 Close——**假 candidate 不等于假 Close**。升版后若怀疑上述任一处，回头补 S3/S5 实测，并按需要抬高下限。

成功 fixture：

```json
{
  "subtype": "success",
  "is_error": false,
  "terminal_reason": "completed",
  "permission_denials": []
}
```

失败 fixture，即使 subtype 表面成功也必须 reject：

```json
{
  "subtype": "success",
  "is_error": true,
  "terminal_reason": "api_error",
  "permission_denials": ["denied operation"]
}
```

字段缺失、类型不符、未知字段或 denial 非空同样失败，不允许猜测默认成功；runtime 也不能把 controller evidence 塞进 terminal result。

## resume 外环

单次首发未达标（hook 因预算放行、候选终态判定未过、或 `budgetExhausted` 标注的 max-turns 硬停）时，主会话可发起 `--resume <session_id>` 续跑；`session_id` 从 `thread.json` 指针取——它在首发 spawn 之前就已落盘，任何终局形态都不缺。续跑请求必须带上与首发完全相同的 `--settings` 文件——不带则 Stop hook 静默失效，续轮判定形同虚设。外环有上限：一次逻辑 run = 1 首发 + 最多 2 次续跑，attempt 序号写入 controller state、单调递增。

**续轮职责是分层的（不是冗余）**：Stop hook 管**会话内**续轮——模型提前自认完成而 postflight 未绿时 block 打回，廉价、不烧 attempt 配额（2026-08-12 真实任务首次实测接管）；控制器 resume 管**跨 attempt** 补活——max-turns 硬停不触发 Stop 事件（实测 hookRuns=0），hook 在这个形态下结构性缺席，补活主责在控制器。因此 max-turns 候选返回 `hookExpected=false`，普通候选返回 `true`；累计对账只统计后者，预算模型不再假设 hook 是唯一的续跑驱动。

计数口径就是这句话的字面意思：**只有真的要 spawn 执行器时才占号**。被 launch 前置闸挡下的调用（binding 对不上、`claude` 版本低于下限或读不出来、hook 文件被改、`baselineDigest` 没存、resume 找不到 thread.json）一格都不占，改正之后配额仍是满的。这不是宽松，而是让计数器只统计它声称统计的东西：占号不可撤销，`prepare` 与 `close` 都不清 `attempts/`，而上述拒绝原因全在 contract 之外——改正它们不改 contract hash，也就不换 state 目录。配额真的用尽时，诊断 `ATTEMPT_LIMIT_EXCEEDED` 会给出出路：换一个 `--controller` 名重跑 `prepare`（写出带全新配额的 state 目录），或在确认没有 run 在跑之后手工删掉那个 `attempts/` 目录。

红项按类型分流，分类由控制器基于自己独立跑出的 postflight 结果判定，不解析 hook 或 evidence 里的 reason 字符串：

| postflight 红项 | 处置 |
|---|---|
| 未达标类（测试红、产物缺、命令结果不符） | 可续：诊断信息随下一次 `--resume` 馈回 |
| 边界违规类（越权 mutation、`permission_denials` 非空等） | 不可续，立即终局——执行器已离约 |

「馈回」的内容有边界，与 codex 侧同一条规定：**diagnostic 只能由 contract 声明的事实与控制器自己的判定构成——postflight 条目 id、该条目在 contract 里的 argv 与 cwd、退出码、红项分类结论；执行体产出的任何字节都不得进入这条通道。** 这里的 diagnostic 是 `claude -p` 的 prompt 位，也就是下一轮的用户回合，容易踩的形态是把红项命令的 stdout 贴进去——而 postflight 命令的 stdout 完全可能是执行体自己上一轮写出来的文件内容（`cat`/`diff`/`jq` 类 verifier 都会），那等于让它自己的产出以指令的身份回到它面前。`--diagnostics-file` 因此收的是一份闭世界的红项清单（`{"reds":[{"entry","code","exit"}]}`，`entry` 必须是本 contract 的 postflight 条目 id，`argv`/`cwd` 从 contract 取而不从文件读），文本由 launcher 渲染；不合形状即进程级失败（exit 1）。

attempt 用尽或超出时间预算同样终局，按 diagnostic 报告差异与下一步。

## readback 观测通道

`node scripts/launch.mjs readback --state DIR` 是 claude 线的只读观测：通过上述 no-follow 指针读取，对 `transcriptPath`（`~/.claude/projects/<slug(cwd)>/<sessionId>.jsonl`，slug 规则实测为「绝对路径中非 `[A-Za-z0-9-]` 一律替换成 `-`」）做活性观测——文件 mtime、行数、固定枚举后的最后条目类型，外加 prompt 归因（transcript 首条 user 输入的 SHA-256 对 `thread.json.promptSha256`，实测逐字回显）。未知 `type` 只返回常量 `unknown`，不允许 transcript 自带字符串穿过隐私边界。它回答的是「执行体还在干活吗」：mtime 停滞且无 envelope 是 stall 信号，transcript 还在长是在干，envelope 落了是已报终局——这是控制器分辨「干完了 / 卡住了」的独立观测面，不再依赖执行体自报。

边界四条：**fail-open**——slug 是 CLI 内部实现、无稳定性承诺，规则漂移或会话未起的表现是 `available:false`，观测不可用不等于 run 出事，兜底永远是 wall-clock deadline；**恒 exit 0**——把观测缺席标成非零会诱导编排器把它当 run 故障；**零字节出境**——输出只有计数、类型与哈希比对结论（`promptAttribution: match|mismatch|unavailable`），transcript 内容一个字节不回显；**不进证据通道**——readback 结论只供人工处置决策（kill / resume / 继续等），归因 mismatch 是「值得人工核查」的报告信号，readback 无权据此终止任何东西，transcript 字节更不得进入 diagnostic 馈回通道（闭世界规则不变）。

## Postflight 与 Close

候选终态通过字段检查后，启动 Claude 的主会话独立重跑 `postflight` command verifier，并调用 snapshot verify，传入可信编排状态保存的原始 `baseline_digest` 作为 `--expected-baseline-digest`。执行会话贴出的日志不是独立证据。主会话将结果写入与原始 `runBinding` 完全相同的 controller-owned `postflightEvidence`：

```json
{
  "ok": true,
  "reasons": [],
  "binding": {
    "contractHash": "<confirmed contract hash>",
    "baselineDigest": "<trusted baseline digest>",
    "runId": "<controller-issued run id>"
  }
}
```

只有 exact terminal result、success artifact、边界 compare、外部 verifier 与 bound `postflightEvidence` 全绿，公共状态机才可 Close。Claude 不接受 Codex 的 finalization receipt/readback 通道。任一差异都报告安全的 observed、expected 与 next step；不得用成功文本覆盖失败证据。
