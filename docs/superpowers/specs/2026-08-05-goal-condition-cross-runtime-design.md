# goal-condition 跨运行时重构设计

状态：已批准（2026-08-05）

日期：2026-08-05

## 1. 背景与结论

`goal-condition` 已从三步起草器演化成五步协议，但当前实现把三类职责放在同一个长篇 `SKILL.md` 中：边界包编译、Claude Code 启动、终态核验。协议又同时存在于未版本化的个人生效副本和公开模板，靠手工同步维持。

本轮审计确认，展示确认闸、现场核验硬数字和假成功识别是有效资产；Codex 不可发现、缺少 Codex adapter、启动前没有基线、参数替换污染、旧测试继续背书新协议和模板漂移则是确定性缺陷。因此当前版本不能作为跨运行时无人值守入口。

本设计选择根因级重构：将平台无关的运行契约与 Claude/Codex 执行方式分离，以结构化文件、哈希确认、启动前快照和独立终验组成闭环。

## 2. 根因、备选方案与取舍

### 2.1 根因

根因不是单个语法错误，而是缺少稳定接口：自然语言 skill 同时承担编译器、launcher 和 verifier，且没有机器可校验的中间产物。每次新增事故教训只能继续往正文追加，最终导致行数膨胀、平台耦合、测试失真和副本漂移。

### 2.2 最小改动方案

最小方案只修静态缺陷：压缩到 200 行以内、清除 dollar-number 参数替换模式、更新旧测试和公开 README，并为当前任务人工起草一份 Codex objective。

收益是落地快；代价是仍然依赖人工复制和事后解释，不能解决多目标串线、启动前基线、外部资产审计、跨运行时发现与单一事实源问题。该方案仅保留为紧急回退路径。

### 2.3 彻底方案

彻底方案引入一个平台无关 run contract，核心 skill 只负责判输入、生成契约、展示确认和路由 adapter。Claude 与 Codex 的权限、启动、状态和完成语义放入各自 reference。机器脚本负责契约校验、稳定渲染、哈希、基线快照和终验对比。

公开仓只保存脱敏协议、schema、adapter 和测试；私有项目锚点保留在本地 profile。安装使用链接而非手工复制，使 Claude 与 Codex 读取同一份核心协议。

### 2.4 Trade-off

| 维度 | 最小方案 | 彻底方案 |
|---|---|---|
| 初始改动 | 小 | 中等 |
| Codex 支持 | 单次人工 | 一等 adapter |
| 防副本漂移 | 无 | 核心单一源 + 安装校验 |
| 边界证明 | 事后人工 | preflight + postflight |
| 特殊字符安全 | 依赖复制方式 | 文件输入 + 内容哈希 |
| 外部资产 | 容易漏验 | 契约声明 verifier；不可验证时阻断 |
| 长期维护 | 继续堆正文 | 核心精简，细节按运行时拆分 |

## 3. 设计目标与非目标

### 3.1 目标

- 同一份核心协议可被 Claude Code 和 Codex 发现并使用。
- `SKILL.md` 不超过 200 行，description 只写触发条件，不摘要工作流。
- 编译过程完整保留目标、判断标准、硬边界、待机制化项、验收物、允许变更和资源边界。
- 多目标输入必须先选择一个目标；禁止将两个 goal 静默合并。
- 任何 launch 或 `create_goal` 之前，用户都能看到精确内容和哈希，并明确确认。
- 基线必须在启动前成功落盘；基线失败即禁止启动。
- 运行结束后由主会话独立验证，不由执行会话自证。
- 无法物理拦截的边界必须标记为 `audit_only`，不得伪装成已机制化。

### 3.2 非目标

- 不实现新的 Claude `/goal` 或 Codex Goal 引擎。
- 不把模型或 reasoning effort 塞进不支持这些字段的 goal API。
- 不承诺文字规则能替代 sandbox、只读凭证、hook 或 API proxy。
- 不在公开仓保存任何组织名、私有路径、密钥、数据集名或内部资产 ID。
- 本次重构不自动启动任何真实业务 goal。

## 4. 架构

### 4.1 组件边界

| 组件 | 单一职责 | 依赖 |
|---|---|---|
| `SKILL.md` | 判输入、生成 run contract、展示确认、选择 adapter | contract reference |
| `references/run-contract.md` | 字段语义、编译规则、确认与终验状态机 | 无 |
| `references/adapters/claude.md` | Claude `/goal`、权限与 result 判据 | Claude Code |
| `references/adapters/codex.md` | Codex goal tools、预算与完成语义 | Codex client |
| `references/anchors-and-rules.md` | 安装实例的项目锚点与铁律 | 项目 profile |
| `schema/run-contract.schema.json` | 机器可校验的契约形状 | JSON Schema |
| `scripts/validate-contract.mjs` | schema 外的不变量检查与稳定渲染 | Node.js 标准库 |
| `scripts/snapshot.mjs` | preflight 快照与 postflight 对比 | Git、profile verifier |
| `scripts/install.mjs` | 从指定 Git commit 生成共享安装包和来源清单 | Git、Node.js 标准库 |
| `tests/` | 静态、契约、adapter 和压力场景测试 | Node.js test runner |

核心 skill 不复制 CLI 帮助和平台细节。运行时细节只在对应 adapter 中出现，项目数据只在 profile 中出现。

### 4.2 Run contract

契约采用 JSON，避免 YAML 隐式类型和 shell quoting。最低字段如下：

```json
{
  "version": 1,
  "runtime": "codex",
  "objective": "One self-contained objective",
  "context_sources": [
    {
      "id": "CTX1",
      "path": "/absolute/worktree/context.md",
      "sha256": "0000000000000000000000000000000000000000000000000000000000000000"
    }
  ],
  "target_roots": ["/absolute/worktree"],
  "judgment_criteria": [
    {"id": "J1", "rule": "Observable decision rule", "why": "Reason"}
  ],
  "success_criteria": [
    {"id": "S1", "command": "exact verifier", "expected": "exact result"}
  ],
  "constraints": [
    {
      "id": "C1",
      "rule": "Boundary",
      "enforcement": "physical",
      "mechanism": "sandbox or deny rule",
      "verify": "postflight check"
    }
  ],
  "allowed_mutations": {
    "files": ["/absolute/worktree/output/**"],
    "git": ["commit"],
    "external": ["explicit allowed operation"]
  },
  "preflight": [
    {"id": "P1", "type": "git", "target": "/absolute/worktree"}
  ],
  "postflight": [
    {"id": "V1", "type": "command", "cwd": "/absolute/worktree", "argv": ["node", "verify.mjs"]}
  ]
}
```

`budget` 是可选对象，可包含运行时支持的 turn、时间、token 或费用边界。不支持或未由用户明确给出的预算字段必须省略，不能发明默认钱数或 token 数。adapter 只把运行时原生支持的字段传给 API，其余边界作为监控判据。`runtime` 一次只能选一个。`objective` 必须内联关键约束和验收条件；可以引用 contract 中以 `id/path/sha256` 绑定 bytes 的稳定 context 文件补充证据，但不得引用“上文”“之前讨论”等会被 compaction 吃掉的内容。

### 4.3 状态机

1. **Classify**：区分任务描述、边界包和已有 contract；多目标先选目标。
2. **Compile**：读取稳定 context 与项目 profile，生成完整 JSON。
3. **Validate**：schema、路径、命令和硬数字检查；失败则停。
4. **Preview**：渲染完整 objective、自检表、机制化矩阵和 SHA-256。
5. **Confirm**：用户确认当前哈希；任何字节变化都使确认失效。
6. **Preflight**：在隔离 worktree 内核对 content-bound context，记录完整 Git、文件和外部资产基线；controller 保存外部 baseline digest 并建立 bound preflight evidence。
7. **Launch**：仅 adapter 可执行；不得递归生成新 goal。
8. **Postflight**：主会话重跑 success criteria、传入外部 baseline digest 对比边界，并提交 bound controller evidence。
9. **Close**：全部通过才报告完成或调用运行时完成接口；否则报告差异。

## 5. Runtime adapters

### 5.1 Claude Code

Claude adapter 将 objective 编译为 `/goal` condition，保留可测量终态、表面化证据、约束和 turn/time clause。非交互运行使用文件读取后的单一参数，不把 condition 拼进单引号 shell 字面量。

权限边界通过明确的 `--disallowedTools` 或任务级 `--settings` 注入。若 scoped Bash rule 无法可靠表达边界，则升级为 sandbox、hook、只读凭证，或标为 `audit_only` 并再次请求确认。完成判定只接受 exact `subtype/is_error/terminal_reason/permission_denials` result，并要求同一 `runBinding` 的 controller-owned preflight/postflight evidence。

### 5.2 Codex

Codex adapter 在用户确认后调用 `create_goal`，将编译后的自含 objective 作为唯一目标。仅当用户明确给出 token budget 时才传 `token_budget`。模型与 reasoning effort 属于会话配置，adapter 只验证/提示，不冒充 goal 参数。

运行期间用 `get_goal` 读取状态。公共状态机只接受 exact `ready_for_postflight` candidate；同一 `runBinding` 的 controller-owned preflight/postflight evidence 全绿且没有剩余工作后，才允许 `update_goal(status="complete")`，随后还要用独立 receipt 与 `get_goal` readback 验证持久终态。`blocked` 必须遵循运行时规定的重复阻断阈值，不能用来表示“暂时没做完”。

Codex 当前环境若无法物理限制某个外部 API 动作，contract 必须将其标为 `audit_only`；需要物理保证时，在只读凭证、proxy 或独立 sandbox 就绪前不启动。

## 6. 单一事实源与安装

公开仓的 `goal-condition-template/` 是核心协议唯一事实源。个人/项目安装不得手工编辑核心正文：

- `install.mjs` 从明确的 Git commit 物化 closed-world 完整核心包，并记录 source commit、文件哈希与 Git mode；不直接链接临时 feature worktree。
- 私有 `anchors-and-rules.md` 由安装时指定的本地 profile 注入，不进入公开仓或来源清单。
- Claude 与 Codex 个人入口都链接到同一个物化安装包。
- 安装输出的 `manifestDigest` 保存在 release 之外；验证时必须作为 `--expected-manifest-digest` 传回。直接编辑核心并重算内部 manifest 仍会被外部 digest 判为 drift。
- 安装检查必须验证入口目标、运行时可发现性、core 内容哈希和私有文件未被 stage。

公开模板保留一个无私有数据的示例 profile。README 只描述当前协议，不重复容易漂移的步骤细节。

## 7. 错误处理与 fail-closed 规则

下列任一情况禁止 launch 或禁止 complete：

- context 文件不存在、仍位于临时目录或哈希与预览不一致；
- 输入含多个目标而未选择；
- contract 缺 judgment criteria、success criteria 或目标根；
- preflight 任一快照失败；
- 硬边界声称 `physical` 却没有可执行 mechanism 和 fault-injection 证据；
- 目标仓无预期 branch/upstream，且 contract 未声明对应分支；
- API error、缺产物、permission denial、验证命令输出不符；
- 运行触及未列入 `allowed_mutations` 的文件、Git ref 或外部资产；
- Claude 运行贴近 turn 上限，或 Codex 仍有未完成事项。

错误输出必须列出安全字段位置、观测指纹、期望值和下一步；用户控制的 key、ID、路径片段和值不得原样回显，也不能只写“验证失败”。

## 8. 测试策略

### 8.1 RED 基线

已存在的真实失败作为第一批 RED 证据：

- 旧 skill 对 Codex 运行请求仍输出 Claude launcher；
- 当前工作区无法发现项目级副本；
- 只有事后检查，没有启动前基线；
- 参数替换导致正文静默污染；
- API error 与表面 success 同时出现；
- 多副本和旧测试继续产生错误完成声明。

这些失败先固化为可重复测试，测试必须在新实现前失败。

### 8.2 自动测试

- 静态不变量：frontmatter 可解析、description 只含触发条件、`SKILL.md` ≤200 行、引用存在、无 dollar-number 模式。
- Contract：必填字段、单目标、预算不臆造、判断标准无损、稳定 JSON 渲染。
- 特殊字符：中文、换行、单双引号、反斜杠和 dollar 文本在预览与 adapter 输入间字节一致。
- Preflight/postflight：原有 dirty state 与本次变更可区分；缺 upstream、非 Git 根和多仓均有明确分支。
- Adapter stub：Claude/Codex 只消费确认哈希对应的 contract；错误终态不得 complete。
- 安装：Claude 与 Codex 入口解析到同一 core hash，私有 profile 不出现在公开扫描中。

### 8.3 行为压力测试

至少覆盖以下场景，并保留 no-skill 对照：

- 用户同时说“直接跑”和“赶时间”，agent 仍停在 preview；
- 输入同时含 Goal A/Goal B，agent 只允许选择一个；
- 外部边界无法机制化，agent 不把文字约束宣称为物理拦截；
- 执行器声称完成但产物缺失，主会话拒绝 complete；
- context 在 compaction 后不可见，agent 只从稳定文件恢复，不引用旧对话。

先做低成本 contract/stub 测试，再做新会话黑盒。真实 Claude 或 Codex goal 都属于单独的用户确认动作，不能被测试套件擅自启动。

## 9. 迁移顺序

1. 添加失败测试和 contract schema，确认 RED。
2. 精简核心 `SKILL.md`，拆出两套 adapter 与 run-contract reference。
3. 实现 validator、稳定 renderer、snapshot/diff。
4. 修公开 README 与示例 profile，跑静态和 stub 测试。
5. 建立私有 profile 和双运行时安装链接，验证当前工作区可发现。
6. 将当前业务 context 从临时路径迁入其私有项目的稳定文档目录。
7. 从稳定 context 生成单目标 Codex contract，展示全文与哈希。
8. 用户再次确认后，才允许启动真实 Codex goal。

## 10. 验收标准

- 公开核心、Claude 生效入口、Codex 生效入口解析到同一核心哈希。
- 核心 `SKILL.md` 不超过 200 行，全部静态门禁通过。
- 旧三步/五步文案漂移消失，README 与 adapter 一致。
- 单目标 contract 无损保留所有边界包字段和允许变更。
- 预览、确认、preflight、launch、postflight、close 的顺序不可跳。
- 成功 fixture 完成后可 close；API error、缺产物、权限拒绝和边界差异均 fail closed。
- 公开仓敏感扫描零命中，私有 profile 未被 stage。
- 当前业务 Goal A 只生成待确认 contract；未经新确认不调用真实 goal。

## 11. 交付边界

实现改动分别落在独立任务分支，不直接提交到 main，不 push，不发布，不运行真实业务 goal。设计提交只包含本文件；实现计划与代码在用户审阅本 spec 后另行进入。
