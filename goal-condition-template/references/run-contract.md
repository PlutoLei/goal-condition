# Run contract 字段与编译规则

Run contract 是核心 compiler 与 runtime adapter 之间的平台无关 JSON 接口。其 closed-world 形状以 [schema](../schema/run-contract.schema.json) 为声明，以 [validator](../scripts/validate-contract.mjs) 为本仓实际校验器；本文解释语义，不复制完整 schema。落盘的 canonical JSON bytes 是唯一权威 contract artifact，不存在另一个“语义等价即可”的 launch 输入。

## 顶层字段

| 字段 | 语义与编译要求 |
|---|---|
| `version` | 当前恒为 `1`。其他值 fail closed。 |
| `runtime` | 一次只选 `claude` 或 `codex`。 |
| `objective` | 单一、非空、自含的目标。多目标输入先让用户选择，不得写数组或静默合并。 |
| `context_sources` | content-bound stable context 列表；每项只能含唯一 `id`、绝对非临时 `path` 与文件 bytes 的小写 SHA-256 `sha256`。Snapshot 会独立重读并核对 bytes、物理路径与 mode。 |
| `target_roots` | 目标绝对路径；snapshot 当前要求恰好一个隔离 root。 |
| `judgment_criteria` | 每项包含唯一 `id`、可观察 `rule` 与 `why`，承接 boundary package 的 judgment criterion。 |
| `success_criteria` | 每项包含唯一 `id`、人类可读 `command` 与精确 `expected`，承接 success criterion 和验收物。 |
| `constraints` | 每项包含 `id`、`rule`、`enforcement`；`physical` 还必须有非空 `mechanism` 与 `verify`。 |
| `allowed_mutations` | 固定包含 `files`、`git`、`external` 三个数组。列入许可不等于动作已经发生或已经通过审计。 |
| `execution_permissions` | 可选且仅用于 `runtime="claude"`。闭世界包含 `bash_prefixes`、`webfetch_domains`、`skills`、`additional_read_roots` 四个可选数组；它声明自动批准/可达面，不声明验收成功或通用物理隔离。 |
| `budget` | 可选。存在时 `user_provided` 必须为 `true`，且至少有一个用户明确给出的正数限制；`max_turns` 另须为整数（见下）。 |
| `preflight` | 启动前的 Git、path 或结构化 command entry，至少一项。 |
| `postflight` | 主会话独立执行的结构化 command verifier，至少一项。 |

所有 context、criterion、constraint、preflight 与 postflight 的 `id` 在整个 contract 内唯一。未知字段、重复 ID、非规范/相对路径，以及 `/tmp`、`/private/tmp`、`/var/folders`、`/private/var/folders` 或其词法别名均被拒绝。

`execution_permissions` 的数组元素必须是非空字符串；`additional_read_roots` 另须为绝对、规范、非临时路径。Claude 权限规则是没有转义语法的 `Tool(specifier)` 字符串 DSL，因此 prefix/domain/skill 与 target root 含括号、换行或首尾空白时无法安全编译，validator 以 `PERMISSION_SPECIFIER_UNREPRESENTABLE` 拒绝。编译层用同一规则复核 realpath 后的 target root、controller state 与 hook path，launch gate 还会独立拒绝直接调用绕过。**postflight verifier 不进 Bash allow-list**：argv 是 execFile 语义、Bash specifier 是 shell 字符串语义，两者之间没有可靠编码（argv[0] 通配把整个可执行家族授权出去，整条拼接则既可能在 shell 语义下多授权一条命令、又可能产出永不匹配的死规则）；verifier 由 Stop hook 以 `execFileSync` 执行，不经 Claude 权限，执行体要自行运行 verifier 须由作者显式 `bash_prefixes` 声明。`bash_prefixes` 生成前缀 `Bash(<prefix>:*)`，另生成 `WebFetch(domain:<domain>)` 与 `Skill(<skill>)`；除首个工作目录外的 target root 和 `additional_read_roots` 经 realpath 规范后进入 `permissions.additionalDirectories`。`additional_read_roots` 不得与 controller state 目录或 hook 脚本有任何包含关系（那是 `requires_env` 凭证与控制器证据所在，deny 只有 Edit、拦不住读），launch 前置闸直接拒绝。实际 launch cwd 同样取 canonical 首 root，并在 spawn 前复核全部 target root 与 `additional_read_roots` 的 device/inode；resume 核对 pointer 记录的 launch-time canonical cwd、全部 target root 与 `additional_read_roots`，任何一根漂移即拒。Claude runtime 会把预存 `.claude/settings*.json` 的 `permissions` 段 union 进 effective allow-list，launch 前置闸因此拒绝任何带 `permissions` 段的预存 project settings（只设 model/hooks 的无害配置放行；读不安全的形态——symlink、非 regular file、超限大文件——同样保守拒绝，且 spawn 前最后一刻还会复扫一次）。扫描范围精确跟随实测的加载面：每个 target root 自身的两个 settings 文件，加 enclosing git root（当 target root 是仓库子目录时）的 `settings.local.json`——后者自 CLI 2.1.211 起从 git root 加载而非 cwd。字段名里的 `read` 不是 OS 级只读承诺：在固定的 `acceptEdits` 模式下 additional directory 也可能被编辑，实际 mutation 仍由 `allowed_mutations` 与 baseline compare 裁决。

四个 budget 限制里只有 `max_turns` 额外要求整数，因为 CLI turn 数与 Stop hook block 计数都没有小数语义。Claude 未显式给 turn budget 时使用 `DEFAULT_MAX_TURNS=50`；用户显式给出的整数原样进入 `--max-turns`，可高于默认值，但超过 `MAX_TURNS_CEILING=200` 会在 launch 前置闸失败，不静默钳制。`max_minutes` 与 `max_cost_usd` 的小数有真实语义（`0.5` 分钟 = 30 秒），`max_tokens` 原样透传给 runtime，因此都不设整数闸。

## Boundary package 编译映射

| Boundary 语义 | Run contract 表达 |
|---|---|
| goal | `objective`，只保留一个目标并内联完成所需关键条件 |
| context | `context_sources` 与 `target_roots`；每份来源必须稳定可重读，并在 contract 内绑定其 bytes SHA-256 |
| hard boundary | `constraints[].rule` |
| judgment standard | `judgment_criteria[].rule` 与 `why` |
| acceptance artifact | `success_criteria[].command` 与 `expected` |
| mechanization | 可执行且可 fault-inject 的约束用 `physical`；其余用 `audit_only` |
| mutation scope | 分别落入 `allowed_mutations.files/git/external` |
| verifier | 启动条件放 `preflight`；独立成功核验放 `postflight` |
| execution authorization | Claude 自动批准的 Bash prefix、WebFetch domain、Skill 与额外目录写入可选 `execution_permissions`；Codex 出现该字段即红 |
| resource limit | 仅用户明确给出时写 `budget` 并保留 provenance |

`success_criteria.command` 是供人审阅的精确命令说明，不是 shell 执行入口。机器执行只允许 `{id, type:"command", cwd, argv, requires_env?, capture?}`；不得增加 `shell` 字段，不得用 `eval`、`sh -c` 或拼接后的 shell 字符串。`requires_env` 只记录变量名和是否存在，snapshot 不保存变量值。默认 `capture:"hash"`；只有确认输出不含敏感内容时才可显式使用 `capture:"text"`。

Preflight 的 Git entry 使用 `target`，可声明 `require_branch`、`require_clean`、`require_upstream`；path entry 使用 `target` 与 `require: file|directory|exists`；command entry 使用 `cwd + argv[]`。这些 target/cwd 都必须位于 snapshot 要求的唯一 target root 内。Postflight 只接受 command entry，Git 与 path 边界由 baseline compare 复验。

`require_branch`、`require_clean`、`require_upstream` 是 **launch 前置条件，不是 run-long 不变量**：它们只在 `snapshot.mjs capture` 采集 baseline 时判定，`verify` 阶段一律跳过。原因是 run 一旦产出 `allowed_mutations.files` 里声明允许的文件，工作树相对 baseline 就必然变脏——在 verify 重跑 `require_clean` 会让「产出了正确结果」结构性必红，且诊断会指导操作员删掉被验收对象本身。verify 阶段的 Git 边界完全由 baseline compare 承担，且比重跑谓词更精确：`GIT_BRANCH_CHANGED` 钉住分支不得偏离 baseline，`GIT_UPSTREAM_CHANGED` 钉住 upstream 配置不得变动，工作树与提交材料按 `allowed_mutations` 逐路径归类为 change 或 violation。跳过的只是谓词判定，Git 材料（refs、tree、index、worktree 清单、ancestry）在两个阶段一样完整采集。

Snapshot 的文件许可只接受绝对精确路径或以 `/**` 结尾的目录前缀；其他 glob 元字符被拒绝。Git compare 当前只把精确的 `commit` 许可解释为允许 HEAD 前移，branch 变化仍然违规。`allowed_mutations.external` 是声明，不是远端动作证据；必须另配独立 verifier，否则只能作为 `audit_only` 观察项。

## 校验、preview 与确认

使用以下接口验证，不执行 contract 中的任何命令：

```text
node scripts/validate-contract.mjs --contract <contract-file> --preview
```

Validator diagnostic 固定包含 `code`、安全的 `path`、`observed` 指纹、`expected`、`next`。用户控制的 unknown key、ID、路径片段和值不进入诊断文本；相应位置使用稳定的数组索引或通用字段名，observed 只使用类型、长度、byte length 或 SHA-256 指纹。Snapshot diagnostic 用 `entry` 与 `field` 定位已通过 contract validator 的 entry，并同样给出 observed、expected 和 next step。调用方必须完整展示这些安全字段，不得把失败折叠成一句“验证失败”。

**Launch 层信任 Validate 已执行。** `readContract` 只做字节级检查（无 BOM、strict UTF-8、与 `canonicalJson(parsed)` byte-identical），不重跑字段级校验；`scripts/launch.mjs` 同样不复查 `target_roots` 是否唯一、`argv` 是否非空、`budget.max_turns` 是否整数这类不变量。这是设计而非疏漏：字段级政策只有一个执行点（validator），launch 依赖状态机把关——`nextAction` 只在 `validation` 为空数组时才会给出 `launch`。绕过 Validate 直接调用 launcher，就是自己放弃了这一层保证。

Contract 文件的字节级错误采用隐私安全诊断。`CONTRACT_BOM_FORBIDDEN` 在解析前拒绝 UTF-8 BOM；`CONTRACT_UTF8_INVALID` 使用 fatal decoder 拒绝非法 UTF-8；`CONTRACT_JSON_INVALID` 拒绝无法解析的 JSON；`CONTRACT_BYTES_NONCANONICAL` 拒绝可解析但不 canonical 的 bytes。四类错误的 `observed` 都只能包含 raw SHA-256 与 numeric byte length，不得包含 parser message、decoder message、原始 excerpt 或转义后的内容片段。

Canonical JSON 递归排序 object key、保持 array 顺序，并追加恰好一个换行。Compiler 必须把 `canonicalJson(parsed)` 原样写成 launchable 文件；`readContract` 要求原始文件与该结果 byte-identical。空白、key 顺序、缩进或额外换行不同都会产生 `CONTRACT_BYTES_NONCANONICAL`，即使重新解析后的对象和 canonical hash 相同也禁止继续，直到重新生成 artifact、重新 preview 并重新确认。

Contract hash 是 authoritative canonical JSON 的 UTF-8 bytes 的小写 SHA-256。完整 preview 在可读矩阵之外逐字包含这份 authoritative canonical JSON，因此 version、runtime、context_sources、target_roots、execution_permissions、budget 以及每个 nested preflight/postflight flag、cwd、argv、requires_env、capture 都可见且被同一 hash 绑定。任何落盘字节编辑都会使当前 artifact 的确认失效；不得只比较解析后的对象来复用确认。

## Preflight 与可信 baseline_digest

[Snapshot CLI](../scripts/snapshot.mjs) 的 capture 形状为：

```text
node scripts/snapshot.mjs capture --contract <contract-file> --out <baseline-file>
```

成功输出同时包含 contract hash 与 `baseline_digest`。编排器必须把这个 digest 保存到 baseline 文件之外、与已确认 contract hash 绑定的可信编排状态；不得从稍后可能被替换的 baseline 文件自行重算后当作信任来源。只有 baseline 文件成功原子落盘、digest 被外部保存、所有 preflight entry 通过，才允许 launch。

当前 snapshot schema version 为 `3`。它把 context 的 `id/path/sha256/mode` 纳入 digest，并为 Git 同时保存 HEAD、branch、upstream、完整 refs map、带 blob bytes SHA-256 的精确 tree material、独立 index entries、effective worktree material、Git clean-filter 投影后的 effective object material、包含 directory mode 的 inventory，以及绑定 exact baseline/current HEAD 的 ancestry evidence。普通文件、目录、symlink 与其他节点都记录 mode；context bytes 或 mode 的变化永远是 `CONTEXT_STATE_CHANGED`，不能被 `allowed_mutations.files` 放行。完整 refs map 继续通过普通的 `for-each-ref` 枚举，因此 replacement ref 仍可观察；任何非空 `refs/replace` 都以 `GIT_REPLACE_REFS_UNSUPPORTED` 拒绝。所有 commit/tree/blob、index/status 与 effective material 命令则统一使用 `--no-replace-objects`，避免同一次 capture 混用两套 object 视图。

每个 committed blob 通过无固定输出 buffer 的单次 stream 同时计算 raw bytes SHA-256 和 canonical repository object ID；后者使用 `rev-parse --show-object-format=storage` 返回的 `sha1` 或 `sha256`、`ls-tree -l` 声明的 blob size、`blob <size>\0` header 与同一份 streamed bytes。实际 byte count 必须等于声明 size，computed object ID 必须等于 tree object ID，否则在产出 snapshot 前分别以 `GIT_BLOB_SIZE_MISMATCH` 或 `GIT_BLOB_OBJECT_MISMATCH` fail closed，诊断只包含长度或 digest。普通 committed material 同时保留 `object` 与 `bytes_sha256`；tree compare 不再因 HEAD 相同而跳过，同 HEAD 或同 mode/type/object identity 下的 bytes/material drift 永远以 `GIT_COMMITTED_OBJECT_INTEGRITY_CHANGED` 拒绝，不能被 `allowed_mutations.files` 放行。

Git index 变更单独审计，tag 或其他 refs 的增删改一律违规；只有在 `allowed_mutations.git` 精确允许 `commit`、argv-only `git --no-replace-objects merge-base --is-ancestor` 证明 current HEAD 是 externally-bound baseline HEAD 的后代、且唯一变化 ref 是当前 branch 时，才把前移视为允许的 commit。Shallow repository 与非空或非 regular `info/grafts` 会在证明前被拒绝。Verifier 还会把发生变化的 committed tree path 与 baseline effective filesystem 的 Git-projected object/type/mode 对比；directory state 会递归展开为 Git leaf。预先存在的受保护 dirty material 被原样提交可以通过，受保护 material 的新增、删除或 object/type/mode 改变会失败，声明允许的路径则记入 changes。这样 clean/smudge 或 CRLF 规则不会把 raw worktree bytes 错当成 canonical committed object。

Snapshot 在 capture 前还会验证 target root 与 context 的物理路径：root 必须是非 symlink 的稳定目录，context 必须是 root 内的非 symlink regular file，二者的 realpath 都不得落入临时存储。Contract 中的 context hash 与现场 bytes 不一致时必须重新生成、完整 preview 并重新确认，而不能把现场文件静默吸收到旧 contract。

Postflight verify 必须显式回传原先保存的值：

```text
node scripts/snapshot.mjs verify --contract <contract-file> --baseline <baseline-file> --expected-baseline-digest <trusted-digest>
```

库调用同样必须把可信值作为 `compareSnapshot(contract, baseline, current, { expectedBaselineDigest })` 的 `expectedBaselineDigest` 传入。缺失、非小写 SHA-256、baseline 被替换、contract hash 变化、entry 集不完整或边界差异都会 fail closed。`baseline_digest` 握手验证的是 baseline 完整性；它不能替代 `postflight` 对成功产物与远端副作用的独立核验。

## 失败与完成

状态顺序由 `nextAction` 固定为 validation、hash confirmation、controller preflight、runtime result 与 controller postflight。主会话先建立 exact `runBinding={contractHash,baselineDigest,runId}`，再提交同一 binding 的 closed-world `preflightEvidence={ok,reasons,binding}`；两个 runtime 都不能在缺少这条 controller-owned 证据时 launch。Claude 的 untrusted terminal result 只能含 `subtype/is_error/terminal_reason/permission_denials` 四个字段，且只有 exact success 与 bound `postflightEvidence` 全绿后才 complete。

Codex 的 untrusted runtimeResult 只能是 exact candidate `{status:"ready_for_postflight",remaining_work:false}`；complete、readback 或任何额外字段均拒绝。其后由可信编排器提供 controller-owned `postflightEvidence`、`finalizationReceipt` 与 `runtimeReadback`，每项都绑定同一 `runBinding`。动作顺序固定为 `postflight` → `finalize_runtime` → `verify_runtime` → complete，缺项、乱序、cross-binding、失败或未知字段都 fail closed。公共 contract 不把候选态伪装成持久终态。

这里的纯函数只能校验通道的 closed-world 形状、顺序与 binding 一致性，不能认证真实 tool call。调用方必须自己拥有这些通道：不得把执行器输出反序列化成 `preflightEvidence`、`postflightEvidence`、`finalizationReceipt` 或 `runtimeReadback`，也不得让 runtime 伪造 verifier 结果、`thread/goal/set` receipt 或 `thread/goal/get` envelope。

## Release trust root

安装器只从 pinned Git commit 读取公开核心的精确 closed-world 文件集，并在缺少任何成员时于 release、backup 或 runtime link 变更之前失败。安装成功会返回/打印 `manifestDigest`；编排器必须把它保存到 release 之外。以后验证必须提供该 external trust root：

```text
node scripts/install.mjs verify --release <release-directory> --expected-manifest-digest <trusted-manifest-digest>
```

Verifier 先比较原始 `manifest.json` bytes 的小写 SHA-256，再解析 manifest 并核对核心文件 bytes、exact Git-derived mode、profile hash/fixed `0600` mode、manifest `0644` mode、release root/release directory/required directories 的 exact `0755` mode、目录闭包和 unexpected entries。所有 mode 都用 `lstat.mode & 0o7777` 的四位八进制值比较，因此 setuid、setgid 或 sticky bit 不会被掩掉。Release 内部被一起重算的 manifest 不具备外部信任；缺少 digest 或 digest 不匹配都 fail closed。安装事务对 link parent、release root 与 backup root 的物理 directory identity 做阶段性复核，覆盖 lock、stage、backup、cutover、readback、rollback 与 owned cleanup；祖先被重定向时停止，而不是沿新的 symlink 拓扑写入。

任何 physical mechanism 无法验证、外部动作没有观察面、runtime 结果格式不完整、success artifact 缺失、命令退出非零或 mutation 越界时，都报告对应 diagnostic 并停止。只有独立 postflight 全绿且无剩余工作时，主会话才能进入 Close。
