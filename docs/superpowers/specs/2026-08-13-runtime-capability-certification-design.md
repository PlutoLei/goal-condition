# Runtime capability certification decoupling design

状态：设计方向已确认；待文档总审与实现计划

日期：2026-08-13

决策范围：release identity、runtime capability gate、Claude live certification

## 0. 决策摘要

goal-condition 不再把“整套 release 完整”与“每个 runtime 已经通过真实供应商 canary”视为同一状态。

安装仍保持一次原子事务和一份 immutable release，但 release manifest 为 Codex 与 Claude 计算独立的
runtime surface digest。公共核心或 Codex-only 变化不会使 Claude 认证失效；共享执行面或 Claude 专属
执行面变化会使 Claude 退回 Candidate。

Claude Code 只承担两种不可替代的职责：

- 用户明确选择 `runtime="claude"` 后的真实执行；
- 验证 Claude CLI 自身的 setting-source、flag settings、Stop hook 与 result envelope 行为。

代码实现、静态审查、fake-executor 回归、contract 编译、snapshot、postflight，以及 Codex runtime
均不依赖 Claude Code 账户额度。缺少有效 Claude certification receipt 时，普通 Claude launch
fail closed；Codex 与公共离线能力继续工作。

## 1. 问题与根因

### 1.1 当前事实

当前 release installer 的 closed-world file set 同时包含共享核心、Codex controller 和 Claude adapter。
安装 manifest 只有整包 `manifestDigest`。Codex GoalSession v2 已有独立的
`disabled → canary → enabled` release gate，但 Claude adapter 没有同等级的 capability gate。

`5c67c08` 的 setting-source isolation 改动已经通过离线测试与 review，剩余 live gate 必须真实观察：

1. ambient project `Read(*)` deny 在 control lane 生效；
2. adapter lane 在 `--setting-sources ""` 下成功且无 permission denial；
3. sentinel-derived output 正确；
4. Controller flag settings 中的 Stop hook 确实运行；
5. project settings 与受保护 baseline bytes 未变化。

Claude Max 会话额度在 tool call 前返回 HTTP 429 时，上述五项没有任何一项可以判绿。但这只说明
Claude native certification 暂不可执行，不说明共享核心或 Codex runtime 不可发布。

### 1.2 根因

根因是三种生命周期被压成一条 release-ready 结论：

| 对象 | 正确生命周期 | 当前耦合 |
|---|---|---|
| release integrity | 每次安装产物变化时验证 | 整包 manifest digest |
| runtime implementation | 代码、测试与 review 变化时验证 | 与整包 release 共同表述 |
| vendor-native certification | runtime surface、CLI 或执行环境变化时验证 | 没有独立状态，只能阻塞整包结论 |

个人 Claude 订阅成为唯一 live canary 执行身份，使供应商认证又与个人会话额度耦合。这个依赖属于
认证基础设施，而不是产品运行架构的必然要求。

## 2. 目标、非目标与不变量

### 2.1 目标

- release integrity 与 runtime certification 分开表达、分开失效。
- Claude 未认证时只阻止普通 `runtime="claude"` launch。
- Codex-only 变化不要求重跑 Claude live canary。
- shared 或 Claude runtime surface 变化、Claude CLI 版本变化、平台/架构变化、认证方式变化时，旧回执失效。
- live canary 继续走真实 `prepareClaude → runClaudeAttempt` 路径，不引入测试专用捷径。
- canary 红或 API/额度错误不会覆盖上一条证据，也不会生成 Certified receipt。
- 不把凭证、账号标识、API key 或 transcript bytes 写入 manifest、receipt 或日志。

### 2.2 非目标

- 不用 Codex 模拟结果替代 Claude native evidence。
- 不拆成多个独立安装事务或多个 release 目录。
- 不让普通用户 launch 自动触发付费 canary。
- 不把 Claude certification 扩张成任意供应商测试平台。
- 不改变 canonical run contract、hash confirmation、baseline 或 postflight 信任模型。
- 不在本设计中 provision、复制或存储 Anthropic 凭证。
- 不 retroactively 修改已经安装的旧 release。

### 2.3 必须保持的不变量

~~~text
ReleaseIntegrity(release) = verified against externally trusted manifest digest

RuntimeSurfaceDigest(runtime)
  = digest(runtime-shared closed-world files + runtime-specific closed-world files)

Certified(runtime, environment)
  only if receipt.runtime_surface_digest == current runtime surface digest
  and receipt.source == current verified source identity
  and receipt.cli_version == current probed CLI version
  and receipt.platform == current platform/architecture
  and receipt.auth_mode == current non-secret auth classification
  and receipt.auth_context_id == current opaque auth context ID
  and every required canary condition has controller-owned pass evidence

Uncertified(claude) => ordinary Claude launch denied
Uncertified(claude) != Codex launch denied
~~~

## 3. 方案比较

| 方案 | 收益 | 代价 | 决策 |
|---|---|---|---|
| A：等个人额度恢复后手工跑一次 | 无代码改动，最快解除当前门禁 | 以后仍反复受个人额度和整包结论影响 | 保留为当前 commit 的临时路径 |
| B：整包 release digest + Claude receipt | 能把 Claude launch gate 独立出来 | 任意 Codex-only 变化仍使 Claude receipt 失效 | 仅作实现降级 fallback |
| C：runtime surface digest + 独立 capability receipt | 认证只随相关执行面失效，根因级解耦 | manifest、runner 边界和状态机需要扩展 | 采用 |
| D：拆成三个独立 package/release | 物理发布边界最彻底 | 安装、兼容、回滚和文档成本显著扩大 | 当前 YAGNI，暂不采用 |

## 4. Release manifest v2

### 4.1 仍然只有一个原子 release

installer 继续从 pinned Git commit 复制完整 `REQUIRED_CORE_FILES`，生成一个 immutable release。发布流程
拆成 `stage` 与 `activate`：`stage` 完成目录闭包、mode、source hash、profile hash 与 manifest 生成，但不
切换任何 runtime link；`activate` 只接受精确 staged manifest digest，并沿用现有原子 link switch、readback
与 rollback。现有整包 `manifestDigest` 继续是 release integrity 的外部 trust root。

生产 native canary 对 staged immutable release 执行。通过后，`activate` 切到同一个物理 release 目录，
所以 receipt 不跨 bytes、mode、绝对 release root 或 source kind 复用。stage 创建 release artifact 不等于
activate、install success 或 production effect，交付报告必须分开。

### 4.2 增加 runtime surface digests

manifest schema 升为 v2，在原字段之外增加 closed-world `runtime_surfaces`：

~~~json
{
  "schema_version": 2,
  "commit": "<git commit>",
  "source_files": [],
  "profile_sha256": "<sha256>",
  "runtime_surfaces": {
    "claude": "<sha256>",
    "codex": "<sha256>"
  }
}
~~~

每个 required core file 必须由 installer 常量精确分类为：

- `release_only`：installer、Skill、说明性 reference 与不参与执行的发布资产；
- `runtime_shared`：contract、snapshot、workflow 与 thin dispatcher 等两个 runtime 都会执行的代码；
- `claude`：Claude runner、adapter、permission compiler、certification profile 与 capability gate；
- `codex`：GoalSession controller 与 Codex runner/adapter。

未分类文件、重复分类、未知分类或 runtime surface 为空均在生成 release 前 fail closed。

`runtime_surfaces.claude` 是 canonical digest：输入为 `runtime_shared + claude` 的 manifest source
entries，按 path 排序并保留 path、mode、sha256。Codex 同理使用 `runtime_shared + codex`。
`release_only` 仍受 whole-release integrity 保护，但不会烧掉 native runtime certification。digest 只从
已经进入整包 manifest 的 source entries 计算，不另开一套文件读取或 hash 逻辑。

开发阶段允许 source-checkout canary，它使用同一份分类表和 canonical digest 算法，只接受 HEAD 中的
`runtime_shared + <runtime>` files 与 Git-derived mode；相关文件在 index/worktree 中不同于 HEAD 时
fail closed。其 receipt 精确绑定 checkout realpath 与 commit，只能开启该 checkout 的 runtime，不得转移
给 staged/installed release。生产认证必须直接跑 staged immutable release。

### 4.3 降低无关失效

当前 `scripts/launch.mjs` 同时含通用 CLI、Claude state/attempt 与 runtime dispatch。实现阶段将其收缩为
thin dispatcher 与共享 orchestration，并把 Claude attempt 生命周期移入 Claude runner 模块。只有真正
共享的 dispatcher 变化才同时使两个 runtime surface 失效；Claude runner 内部变化只影响 Claude。

这不是为了追求文件对称，而是防止 Codex-only 修改因为落在一个混合大文件中，机械地烧掉 Claude 认证。

## 5. Claude capability state

### 5.1 状态位置与信任边界

Claude certification state 位于 machine-level controller store，而不是 immutable release 内：

~~~text
<controller-state-root>/runtime-certifications/claude.json
~~~

目录使用 `0700`，文件使用 `0600`，通过 same-directory temporary inode、fsync、atomic rename 发布。
release 内自带的 receipt 没有外部信任价值，禁止使用。

### 5.2 状态形状

状态使用 closed-world schema：

~~~text
ClaudeCapabilityState
├── schema_version: 1
├── mode: candidate | certified
├── changed_at
├── active_source
│   └── {kind: git_checkout, root_realpath, commit}
│       or {kind: immutable_release, root_realpath, manifest_digest}
├── runtime_surface_digest
├── environment
│   ├── cli_version
│   ├── os
│   ├── arch
│   ├── auth_mode
│   └── auth_context_id
└── canary_receipt | null
~~~

`auth_mode` 只接受非秘密枚举，例如 `claude_ai` 或 `api_key`；不保存邮箱、组织、subscription、key hash
或任何可关联账号的值。`auth_context_id` 是 operator 管理的 opaque controller ID，不从 secret 派生；
同一认证主体轮换 credential 时保持不变，切换主体或 administrative policy context 时必须轮换。CLI 无法
对所有认证方式可靠证明 principal，这条轮换责任必须在 certification command 的 preview 中明确展示。

默认状态是 Candidate。以下任一情况使有效状态退回 Candidate：

- certification state 缺失或 schema 不匹配；
- installed release 的 Claude runtime surface digest 不同；
- 当前 `claude --version` 不同；
- `os` 或 `arch` 不同；
- auth mode 或 `auth_context_id` 不同，或无法安全识别；
- current source identity 未通过 Git/manifest integrity 验证；
- receipt 的 source kind、root realpath 或 commit/manifest digest 与 current source 不同；
- receipt 缺失、字段多/少、digest 错误或 canary condition 不完整。

退回 Candidate 是有效态计算，不自动覆盖旧 receipt；保留旧文件便于审计。新的成功 canary 才原子替换它。

### 5.3 普通 launch gate

普通 `runtime="claude"` 的 launch 前置闸新增 `assertClaudeCertified`：

1. 解析 current source identity：externally trusted immutable release manifest v2，或与 HEAD 一致的 Git runtime material；
2. 采集当前 Claude environment；
3. 验证 capability state 与 receipt；
4. 精确匹配 runtime surface 和 environment；
5. 不匹配时返回 `CLAUDE_CAPABILITY_UNCERTIFIED`，不占 attempt、不创建 session claim、不 spawn。

contract Validate、Preview、Confirm 与 Preflight 可以在 Candidate 状态完成；真正 launch 才被阻止。这样用户
能先看到完整 contract 和准确阻塞原因，又不会让 prepare 类操作伪装成已经消耗 Claude 额度。

Codex launch 不读取 Claude capability state。

### 5.4 Codex rollout 同步解耦

Codex 现有 rollout state 同时用 whole-release manifest digest 做完整性 trust root 和 canary key。manifest v2
后将两者拆开保存：`release_manifest_digest` 继续证明整包完整性，`runtime_surface_digest` 与 Codex canary
receipt 绑定。Claude-only 或 `release_only` 变化不再使 Codex certification 失效；`runtime_shared` 或 Codex
surface 变化仍要求新的 Codex canary。

旧 rollout state 不会把 whole-release digest 猜成 runtime surface digest。切到 manifest v2 时，旧
`enabled` 状态迁移为当前 release 的 `canary`，保留审计历史但不继承 certification，直至新的 Codex
runtime-surface receipt 生成。任何 launch 仍先验证 externally trusted whole-release digest。

## 6. Controller-owned Claude certification canary

### 6.1 唯一的 Candidate 执行豁口

Candidate 状态只允许一个显式 certification command 进入真实 Claude adapter。它不是通用 `--force`，也不
接受任意用户 contract。Controller 内置 closed-world canary profile，编译出 disposable target、state、
sentinel 和五项 verifier；然后仍执行标准流程：

~~~text
Compile → Validate → Preview → Confirm(current hash)
→ Preflight → prepareClaude → runClaudeAttempt
→ controller postflight + baseline compare
→ certify receipt → atomic capability-state publish
~~~

因为 disposable path 与 sentinel 每次变化，contract bytes 与 hash 也变化。操作员必须看到完整 preview 并
显式传入当前 confirmed hash；不得复用旧确认，也不得把“运行认证”解释成确认未展示的 contract。

### 6.2 五项 controller-owned condition

receipt 只有在以下条件全部通过时生成：

| ID | 条件 | 证据所有者 |
|---|---|---|
| `ambient-deny-control` | control lane 真实产生预期 Read denial | certification controller |
| `isolated-adapter-candidate` | adapter lane exact terminal candidate 且 permission denials 为空 | certification controller |
| `sentinel-output` | disposable output bytes 的 SHA-256 等于 controller 预期 | certification controller |
| `flag-settings-hook` | `hookExpected=true` 且 `hookRuns >= 1` | certification controller |
| `baseline-preserved` | project settings 与全部 protected baseline material 无变化 | snapshot verifier |

执行器输出只能作为 untrusted runtime result；它不能声明任一 condition 已通过。

### 6.3 Receipt

receipt 绑定：

- receipt schema version；
- source kind、root realpath，以及 checkout commit 或 immutable release manifest digest；
- Claude runtime surface digest；
- CLI version、OS、arch、auth mode；
- opaque auth context ID；
- canonical canary contract hash；
- trusted baseline digest；
- controller-issued run/session identity；
- 五项 Evidence 的 canonical aggregate hash；
- candidate result hash与 postflight report hash；
- certification timestamp。

receipt 不保存 prompt、transcript、sentinel bytes、settings bytes、账号身份或命令 stdout。

### 6.4 失败语义

以下情况全部保持 Candidate，且不发布新 receipt：

- API 429、subscription/session limit、网络错误或 provider error；
- control lane 没有观察到 deny；
- adapter lane permission denial 非空；
- output、hook count 或 baseline 任一不符；
- envelope 形状或 `terminal_reason` 漂移；
- canary contract/hash/baseline binding 不一致；
- 清理前发现未知 artifact 或 mutation。

失败报告区分 `blocked`、`candidate_rejected` 与 `controller_error`，不得把外部额度阻塞写成 canary 红。

## 7. 专用认证身份

代码只定义认证方式和安全边界，不 provision 凭证。推荐运维姿态是专用、低额度、可审计的 Anthropic
API canary identity，避免个人 Max 会话额度成为发布基础设施。

专用身份必须满足：

- 凭证由现有 secret manager 或进程环境提供；
- receipt 与日志不记录账号标识或 secret 派生值；
- canary 使用 disposable target 且无生产外部副作用；
- 预算由 canary operator 明确提供，Controller 不推测；
- 额度/网络错误只影响 Claude certification，不影响 Codex runtime；
- 不允许 `--dangerously-skip-permissions`、`--force` 或任何审计绕过。

个人 OAuth 可以作为人工 fallback，但不再是推荐或唯一认证通道。

## 8. 迁移与兼容

- manifest v1 仍可由旧 release verifier 读取；新 installer 只生成 v2。
- 新代码面对 v1 manifest 时可以验证整包完整性，但 Claude capability 有效态必须是 Candidate，因为缺少
  Claude runtime surface digest。
- 切换到包含本设计的新 release 后，Codex 按自己的 rollout state 工作；Claude 默认 Candidate。
- 不从历史手工 canary、单测 fixture、旧 F-B1 或旧 whole-release receipt 合成新 Claude receipt。
- 现有 Claude session pointer 不迁入新 certification；in-flight session 仍按原 adapter 对账。
- certification state 不随 release rollback 自动改写。回滚后 digest 不匹配会自然退回 Candidate；若存在与
  回滚 surface/environment 精确匹配的历史 receipt，首版仍不自动复用，避免复杂 replay policy。需要重跑 canary。

## 9. 实现分解

### 9.1 Manifest 与 release identity

- manifest schema v2；
- required file capability classification；
- canonical runtime surface digest；
- staged immutable release 与 exact-digest activate；
- install/verify/readback 的 closed-world 校验；
- checkout 模式的等价 runtime surface identity。

### 9.2 Runtime runner 边界

- `launch.mjs` 收缩为 thin dispatcher；
- Claude attempt/claim/settings 生命周期移入 Claude runner；
- 现有 CLI、stdout report、exit code 与 state bytes 保持兼容；
- 不为形式对称而重写已经稳定的 Codex controller。

### 9.3 Capability state 与 gate

- closed-world parser/validator；
- environment probe；
- Candidate/Certified 有效态计算；
- atomic state publication；
- ordinary Claude launch gate；
- Codex isolation regression。

### 9.4 Certification command

- fixed canary profile compiler；
- full preview/hash confirmation；
- control lane + standard adapter lane；
- controller-owned five-condition evidence；
- receipt publication；
- bounded cleanup/readback。

## 10. 测试与验收

### 10.1 离线自动化

- manifest v2 exact shape、canonical bytes、mode/hash/closure；
- 每个 required file 恰好分类一次；
- runtime-shared change 同时改变两个 runtime surface；
- release-only change 不改变任一 runtime surface；
- Codex-only change 只改变 Codex surface；
- Claude-only change 只改变 Claude surface；
- malformed/unknown/duplicate classification fail closed；
- Candidate 阻止普通 Claude launch，且不占 attempt、不写 pointer；
- Candidate 不影响 Codex launch；
- environment/digest/receipt 任一漂移使 Claude 退回 Candidate；
- checkout receipt 不能开启 immutable release；release receipt 不能开启不同 root 或不同 manifest；
- staged/activate 之间的 source identity 与 manifest digest 保持精确不变；
- test-only state 中 fake green canary 的 receipt builder 产出预期 closed-world 形状；五项 condition 任一红均不产出；
- API 429 分类为 external blocked，不分类成 canary failure；
- state publication fault injection 不留下可被误读为 Certified 的部分文件；
- runner 拆分前后现有 stdout、exit code、pointer 与 concurrency tests 全部等价。

### 10.2 真实门禁

离线测试、review 和 fake canary 不能生成 release 可用的 Claude Certified receipt。最终门禁必须使用当前
runtime surface、当前 CLI 和目标认证方式真实执行五项 canary。只有 controller-owned receipt 写入后，
`runtime="claude"` 才从 Candidate 进入 Certified。

代码完成、自动化测试、review、Claude live certification、push、merge、install、release 与 production
effect 必须继续分别报告。

## 11. 风险与控制

| 风险 | 控制 |
|---|---|
| capability file 分类遗漏导致少失效 | 每个 required file 必须恰好分类一次；未知即安装失败 |
| 通过专用 canary command 绕过普通 gate | command 只接受内置 profile，仍需当前 hash 明确确认 |
| receipt 被 release 内文件伪造 | state 保存在 release 外，0600 原子发布，绑定 external manifest/runtime digest |
| CLI 语义变化但版本号不变 | 五项真实行为 evidence；必要时人工撤销 receipt 回 Candidate |
| 个人额度继续阻塞 | 专用 canary identity；额度错误只阻塞 Claude certification |
| runner 拆分引入回归 | 先 characterization tests，再移动代码，保持 CLI/report/state contract |
| checkout canary 被误当 production evidence | receipt 绑定 source kind、root realpath 与 commit/manifest；生产只认证 staged release |
| 认证状态让用户误以为整包发布 | 状态与交付报告继续分层，不把 Certified 等同 installed/released |
| operator 忘记在切换认证主体时轮换 auth context ID | preview 显示 opaque ID 与轮换责任；专用 identity 固定配置并审计变更 |

## 12. 最小 fallback 与最终选择

若完整 runtime surface partition 在实现中发现无法安全收口，fallback 是先让 Claude receipt 绑定整包
release manifest digest。它仍能做到“Claude 未认证不阻塞 Codex”，但 Codex-only change 会触发不必要的
Claude recertification。

最终选择仍是 capability-specific runtime surface digest。它增加一次 manifest schema 与 runner 边界重构，
换来长期稳定的供应商隔离、可审计失效条件和不依赖个人 Claude 额度的发布流程。
