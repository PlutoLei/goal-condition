# goal-condition

给 agent 派活时，别写操作手册，写边界。

整条链路是三步——**边界 → 目标 → 执行**：

| 步 | 做什么 | 由谁 |
|---|---|---|
| **边界** | 把任务砍成一张边界包：硬边界、判断标准、验收物、放层清单 | `boundary-design` |
| **目标** | 按 runtime 编译：Claude 得到 canonical run contract；Codex 得到 GoalSession v2 的 Goal、Authority 与 Design | `goal-condition-template/` router / compiler |
| **执行** | Claude 使用已确认 contract；Codex 只使用已授权 GoalSession v2。两者都由控制面独立终验，执行会话不能自证完成 | runtime adapter + controller |

公开仓只保存脱敏的核心协议、adapter、脚本和测试；具体项目的事实、锚点与核验来源由私有 profile 在安装时注入。

## 为什么

Boris Cherny（Claude Code 作者）给过最简式：*"Describe the task, describe the guardrails, describe the exit criteria, and then just go let the model cook."*

问题是「guardrails 该写什么」本身没人教。实践里大多数人的默认动作是**往上加**——想到一个坑就加一条规则，于是 CLAUDE.md 越来越长、绝对词越来越多，模型反而分不清哪条是真红线。而过度规定步骤会把强模型锁进你的探索空间，互相冲突的规则则消耗推理预算去消解。

boundary-design 的主要动作是**砍**：对每条候选约束问四个问题，判断它该不该存在、该存在于哪一层、该用什么形式表达。用完之后规则变多了，多半是用错了。

## boundary-design 输出

`boundary-design` 输出一张平台无关的边界包，供人审阅或继续编译为对应 runtime 的执行契约：

```text
GOAL: <一句话，带语境>
硬边界（目标不超过五条）:  每条必须对应一个说得出口的高代价失败模式
判断标准（每条带 why）:     给现场可观测的判据来源，不给结论
待机制化:                    能物理拦截的别靠文字
验收物:                      可测量终态 + 需要表面化的证据
资源边界:                    用户明确给出的 turn / token / 时间上限
放层清单:                    每条边界 → 它成立的最小作用域
```

核心是**四判断题**（代价定硬度 / 可推断定写不写 / 作用域定放层 / 可机制化定形式）和**表达形式阶梯**：

```text
文字规则 < 判断标准 < 接口结构 < 验收物 < 物理机制
```

能往高处走就往高处走。阶梯高处的边界不占上下文、不怕被忽略、不需要被「记得」。硬边界为空也完全正常：多数任务只需要判断标准和验收物。

## goal-condition 的当前架构

核心协议不是运行时专属的长提示词，而是两条明确分开的控制路径：

- Claude 使用 canonical JSON run contract 作为唯一权威 artifact，逐字节预览并确认 hash。
- Codex 只使用 GoalSession v2：Goal 与 Maximum Authority 授权后，Design Revision 动态演化，每次执行投影为 immutable Attempt。

Codex V2 内部仍生成一个通过共享 closed-world validator 的私有 `AttemptManifest`，但它只是 launcher ABI；`version: 1` 不是旧 runtime 的入口或 fallback 信号。

| 阶段 | 责任 | 不可跳过的条件 |
|---|---|---|
| `boundary-design` | 产出平台无关的边界包 | 目标、判据、约束与验收物可审阅 |
| router / compiler | 按 runtime 生成 Claude contract 或 Codex V2 Draft | Codex 不得回退旧 lifecycle；Claude contract 必须 closed-world |
| preview / confirm | Claude 展示完整 canonical JSON；Codex 展示 Goal + Authority + Initial Design | 明确确认当前 contract hash 或 authorization hash |
| preflight / prepare | 核对 content-bound Context、root baseline 与当前 workspace | baseline 与控制器状态在执行体可写面之外 |
| runtime adapter | 启动 Claude contract 或 Codex immutable Attempt | 不补写目标、预算或权限承诺 |
| postflight / verify / close | 控制面独立复验产物、边界与 runtime readback | 任一差异、旁路或未对账状态都不得完成 |

`success_criteria.command` 仅是给人审阅的精确命令说明。机器执行只接受 `cwd` 加 `argv[]` 的结构化 command，并以 `shell:false` 启动；不会使用 `eval` 或隐式 shell 拼接。若 Condition 明确把 `/bin/sh -c` 写进 argv，它仍是被审计、hash-bound 且在 verifier sandbox 内执行的显式程序。

### Claude 完整 preview、hash 与基线握手

在任何启动前，先运行 validator 的 `--preview`。它会展示完整的 canonical artifact（包括嵌套的 preflight 与 postflight 参数）和绑定该 bytes 的 SHA-256。确认的是这个精确 hash，不是“语义大致相同”的 JSON。

确认后才 capture baseline。Snapshot schema v3 会绑定 context bytes/mode、文件与目录 mode、Git refs/index/effective material、Git clean-filter 投影后的 effective objects、带 blob bytes hash 的 committed tree，以及 exact baseline/current HEAD ancestry evidence。Refs 仍从正常 Git 视图完整枚举，但任何非空 `refs/replace` 都会被拒绝；commit/tree/blob 与 effective material 的读取统一使用 `--no-replace-objects`。每个 committed blob 只流式读取一次，同时计算 raw SHA-256 和由 repository object format、声明 size 与 bytes 得出的 canonical object ID，二者都会进入或约束可信 tree material；computed object ID 必须等于 tree 中的 object ID。比较器即使在 HEAD 未变化时也会逐项比较 tree，任何同 HEAD 或同 object identity 下的 material drift 都作为完整性错误拒绝，不能被允许路径放行。Snapshot 同时拒绝 shallow history 与 graft metadata；只有当前 branch ref 唯一前移到 baseline 的真实后代才算允许的 commit。capture 输出的 `baseline_digest` 必须由编排器保存到 baseline 文件之外，并与已确认 contract hash 绑定。postflight 验证必须显式传回该受信任 digest；不得从可能已经被替换的 baseline 文件重新计算后当作信任来源。digest 验证 baseline 完整性，不能替代对成功产物或外部副作用的独立 verifier。

```text
node goal-condition-template/scripts/validate-contract.mjs --contract <CONTRACT_FILE> --preview
node goal-condition-template/scripts/snapshot.mjs capture --contract <CONTRACT_FILE> --out <BASELINE_FILE>
node goal-condition-template/scripts/snapshot.mjs verify --contract <CONTRACT_FILE> --baseline <BASELINE_FILE> --expected-baseline-digest <TRUSTED_BASELINE_DIGEST>
```

## 运行时 adapter

Claude 与 Codex 共用底层 snapshot、launcher 安全能力，但不再共用一个公开 contract lifecycle。两个 runtime 都要求控制面独立完成终验；执行会话贴出的成功文本不是完成证据。

| Runtime | 候选终态 | 主会话完成链 |
|---|---|---|
| Claude Code | 只含 `subtype=success`、`is_error=false`、`terminal_reason=completed`、空 `permission_denials` 的 exact result | 独立执行 postflight 与 baseline compare，提交 bound controller evidence 后才 Close |
| Codex | GoalSession v2 executor 只产生 Candidate | controller `verify` → Certified → `finalize` → `close` |

Claude 使用 controller-owned `runBinding`、`preflightEvidence` 与 `postflightEvidence`。Codex V2 由独立 controller 绑定 Authorization、Design Revision、AttemptManifest、LaunchIntent、Evidence、turn receipt 与 runtime readback。候选不得伪造任一控制器证据；任何缺项、乱序、cross-binding、旁路、权限错误或 remaining work 都 fail closed。

整包 `release integrity` 与供应商原生 `runtime certification` 是两份状态。manifest schema v2 的外部摘要证明整个 release 未漂移；Claude/Codex runtime surface digest 只决定相应运行时认证何时失效。代码完成也不等于已经投产：实现、测试、review、Claude live certification、push、merge、install、release 与 production effect 必须分别报告。

Claude 普通 launch 只接受与当前 source、Claude runtime surface、CLI/OS/arch、auth mode 和 opaque auth context 精确匹配的 Certified state；缺失或漂移只得到 Candidate，并在任何 attempt、settings、pointer、lease 或进程副作用前阻断。唯一入口是固定的 `certify-claude-prepare` → 展示完整 preview 与当前 SHA-256 → 明确确认 exact hash → `certify-claude-run`。开发态 Git checkout receipt 绑定 checkout 的 realpath 与 commit，source checkout 认证不能转移给 staged 或 installed 的 external manifest v2 release；生产认证必须直接针对待激活的 staged release。

### Codex GoalSession v2

Codex 只使用 GoalSession v2：用户只确认稳定 Goal 与 Maximum Authority，Boundary、Condition 与 content-bound Context 在授权内以 typed Design Revision 演化，每次 revision 产生新的 immutable Attempt。controller 不可用或 V2 gate 关闭时 fail closed，不回退到旧 Codex lifecycle。旧 contract 只能通过 `migrate-v1` 生成未确认 V2 Draft。Grill 只用于设计评审，不进入 runtime。Context path 必须在 Active Boundary 内；无 `write` Authority 的 Attempt 使用 `read-only` sandbox，获授 `write` 才使用 `workspace-write`。

机器级 store 的 session/run 主键由 controller 生成；调用方用已知的 128-bit `request_id`/`nonce` 绑定创建请求，creation receipt 与 session，或与 LaunchIntent + lease，在同一事务提交。响应丢失后重发完全相同的输入会找回原 ID，同 key 改输入 fail closed。`resume` 只完成这次 durable prepare 并返回 run ID，显式 `launch` 才启动 runtime，避免 runtime 初始化失败吞掉唯一可寻址结果。

LaunchIntent MAC 绑定 controller release digest、AttemptManifest 投影与 target root 物理身份。verify 的额外 native turn、finalize 前后 turn fence 的任何差异都会形成持久化旁路；close 只有证明 runtime quiesced 才释放 controller root lease。V2 gate 使用 `disabled → canary → enabled`；schema-v5 同时记录当前整包 manifest 与 Codex runtime surface digest。只有 Claude/release-only 文件变化时刷新整包审计身份并保留 Codex 认证；Codex/shared runtime surface 变化时清 receipt、自动降为 `canary`。旧 schema-v4 live 状态也一律降为 schema-v5 `canary`，不能把整包摘要冒充运行时认证。

## 安装与私有 profile

安装器从明确的 Git commit 物化共享核心，而不是复制目录。`stage` 只生成并验证 immutable release，不切 runtime link；原生认证直接针对这个物理 release 执行。`activate` 必须重新提供 staged release 的外部 `manifestDigest`，验证 root/digest 后才原子切换显式给出的 runtime link。profile 不应提交到这个公开仓。manifest schema v2 在整包 digest 之外还保存 Claude/Codex 各自的 runtime surface digest；整包 digest 仍是 release integrity 的外部信任根。本节命令都**从本仓 checkout 根目录执行**，因此写作 `goal-condition-template/scripts/install.mjs`；脚本自身打印的 usage 用的是 release 根目录下的 `scripts/install.mjs`。

```text
node goal-condition-template/scripts/install.mjs stage \
  --repo <PUBLIC_REPOSITORY> \
  --ref <COMMIT_SHA> \
  --profile <PRIVATE_PROFILE_FILE> \
  --release-root <RELEASE_DIRECTORY>
```

保存 stage 输出的 `releaseDir` 与 `manifestDigest`。完成该 staged release 所需的 runtime 原生认证后，使用同一 root 和 digest 激活；下面只切 Codex link，Claude link 保持原状态：

```text
node goal-condition-template/scripts/install.mjs activate \
  --release <STAGED_RELEASE_DIRECTORY> \
  --expected-manifest-digest <TRUSTED_MANIFEST_DIGEST> \
  --link codex=<CODEX_SKILL_LINK>
```

`install` 仍作为 `stage` 后紧接 `activate` 的兼容命令存在，但它不提供两个阶段之间运行原生认证的窗口。验证指定 release 时必须显式传回外部 digest；verifier 会先校验原始 manifest bytes，再核对 closed-world 文件 hashes、core 的 exact Git-derived mode、profile `0600`、manifest `0644`，以及 release root 和所有必需目录的 `0755`；四位八进制比较也会拒绝 setuid、setgid 与 sticky bits：

```text
node goal-condition-template/scripts/install.mjs verify \
  --release <RELEASE_DIRECTORY> \
  --expected-manifest-digest <TRUSTED_MANIFEST_DIGEST>
```

Release 只允许以下完整核心集；pinned commit 缺少任何一项都会在 release、backup 或 runtime link 变更前失败：

- `SKILL.md`
- `references/run-contract.md`
- `references/adapters/claude.md`
- `references/adapters/codex.md`
- `references/codex-goal-session-v2.md`
- `schema/run-contract.schema.json`
- `scripts/validate-contract.mjs`
- `scripts/snapshot.mjs`
- `scripts/install.mjs`
- `scripts/lib/contract.mjs`
- `scripts/lib/snapshot.mjs`
- `scripts/lib/installer.mjs`
- `scripts/lib/runner-common.mjs`
- `scripts/lib/runtime-surfaces.mjs`
- `scripts/lib/workflow.mjs`
- `scripts/launch.mjs`
- `scripts/lib/adapters/claude.mjs`
- `scripts/lib/adapters/codex.mjs`
- `scripts/lib/claude-capability.mjs`
- `scripts/lib/claude-certification.mjs`
- `scripts/lib/claude-permissions.mjs`
- `scripts/lib/runners/claude.mjs`
- `scripts/lib/runners/codex.mjs`
- `codex-controller/package.json`
- `codex-controller/schema/goal-session-v2.schema.json`
- `codex-controller/schema/revision-operation-v1.schema.json`
- `codex-controller/src/migration.mjs`
- `codex-controller/src/attempt.mjs`
- `codex-controller/src/capabilities.mjs`
- `codex-controller/src/cli.mjs`
- `codex-controller/src/compiler.mjs`
- `codex-controller/src/domain.mjs`
- `codex-controller/src/evidence.mjs`
- `codex-controller/src/execution.mjs`
- `codex-controller/src/identity.mjs`
- `codex-controller/src/index.mjs`
- `codex-controller/src/policy.mjs`
- `codex-controller/src/projector.mjs`
- `codex-controller/src/recovery.mjs`
- `codex-controller/src/release.mjs`
- `codex-controller/src/rollout.mjs`
- `codex-controller/src/state-root.mjs`
- `codex-controller/src/store.mjs`
- `codex-controller/src/values.mjs`
- `codex-controller/src/verification.mjs`

安装事务对 runtime link parent、release root 与 backup root 的物理 directory identity 反复核对；stage、backup、cutover、readback、rollback 或 owned cleanup 期间发生祖先重定向都会 fail closed。

## 测试

从仓库根目录运行完整回归：

```text
npm test
```

测试覆盖 contract 的 closed-world 校验、canonical JSON/hash、状态机、基线 capture/compare、commit-pinned installer、adapter 静态契约、公开 Markdown 的隐私/loader 门禁、**全仓发布面泄漏闸**，以及五类 paired pressure samples。

发布面泄漏闸（`tests/publish-surface.test.mjs`）扫描**每一个被 Git 跟踪的文本文件**，按模式类而不是按已知样例判定：家目录绝对路径、per-user 临时目录 salt、真实 UUID、凭证样式串、真实邮箱地址。合成占位靠形态与真值区分（合成 UUID 的首段是 8 个相同字符），因此新增占位值不需要维护白名单。它与上面那道 Markdown 隐私门禁关注点不同，互不替代：后者只看 loader 会读进上下文的 Markdown，还要管 `$1` 展开这类 loader hazard。自动测试不会启动真实 goal、访问网络或写入真实 runtime 安装位置；installer 回归会在测试专属临时目录中执行真实 materialize、backup、atomic link switch、rollback 与 TOCTOU fault injection。

`goal-condition-template/evidence/pressure-evidence.json` 保存 prompt injection、多目标压力、伪 physical mechanism、临时 context 和虚假完成五类无工具、无私有上下文的成对模型样本；`codex-goal-session-v2-pressure-evidence.json` 保存动态修订、false-green 与 Grill/runtime 混淆的 RED/GREEN 样本。它们用于公开审阅指令是否改变模型行为；model sample evidence is not deterministic unit proof，也不替代 schema、状态机、真实 canary 与故障注入测试。`pressure-cases.json` 只是确定性的状态机 regression fixture，不被包装成独立行为实验。

## 历史评估说明

仓库曾有一次合成用例评估与一次真实任务 dogfood。它们属于**历史三步版协议**的材料：合成用例与判分同出一个生成器、没有独立真值路径，也没有针对已知缺陷的失败注入。这些结果不构成当前跨运行时实现、hash 确认、baseline digest 握手或 controller-owned Codex 完成链的证据。

历史 dogfood 仍提供一个方法论观察：口述的四条业务约束经现场核实全部已有落点，边界包的文字层应当为空。在维护良好的项目里，boundary design 的主要工作是核实与指路，不是撰写。

## 出处

方法论素材来自公开材料，SKILL.md 里逐条标了引用：

- [The new rules of context engineering](https://claude.com/blog/the-new-rules-of-context-engineering-for-claude-5-generation-models) — Thariq Shihipar
- [Boris Cherny on building Claude Code](https://ycrootaccess.com/p/boris-cherny-building-claude-code) — YC Startup School
- [Effective context engineering for AI agents](https://anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Writing tools for agents](https://anthropic.com/engineering/writing-tools-for-agents)
- [Agent Skills best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices)
- [Claude Code best practices](https://code.claude.com/docs/en/best-practices) / [memory](https://code.claude.com/docs/en/memory)
- [How we contain Claude](https://anthropic.com/engineering/how-we-contain-claude)
- [Prompting Claude Opus 5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5)

「删掉 80% 系统提示词而评测无可测量下降」这个数字只引官方口径 *"over 80% … no measurable loss on our coding evaluations"*；流传的「2,686→514 词」是第三方测量且对应关闭 memory 的口径，不当官方数字引。"unhobbling" 一词源自 Leopold Aschenbrenner 的 *Situational Awareness*。

## License

MIT
