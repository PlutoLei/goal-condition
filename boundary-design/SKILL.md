---
name: boundary-design
description: 当用户要为目标、长任务或 agent 会话设计边界，或需要把任务整理成平台无关的 boundary package 与 run contract 输入时使用。
---

# boundary-design

本 skill 把操作手册式任务描述收敛为“目标 + 少而真实的边界 + 可验证出口”。产物是平台无关的 boundary package，可直接交给 goal-condition 编译成 run contract；runtime launcher 与权限参数由下游 adapter 负责，本 skill 不复制它们。

## 输出格式

```text
GOAL: <一个自含目标，说明范围与目的>

CONSTRAINTS:
  - <高代价失败模式对应的 hard boundary>

JUDGMENT CRITERIA:
  - <现场可观察的判断规则> (why: <理由>)

SUCCESS CRITERIA:
  - <验收物或可测量终态> (verified by: <稳定来源中的核验命令>)

MECHANIZATION:
  - <constraint> → physical: <mechanism + verifier>
  - <constraint> → audit_only: <独立观察面与未物理拦截的原因>

ALLOWED MUTATIONS:
  files: <明确范围>
  git: <明确范围>
  external: <明确范围>

CONTEXT AND VERIFIERS:
  - <content-bound stable context：稳定路径 + bytes SHA-256；以及 preflight、postflight 的来源引用>

OPTIONAL USER BUDGET: <只记录用户明确给出的限制；否则省略>
```

硬边界为空是正常结果。不要为了格式凑规则；每个字段都应对应可观察的失败或完成语义。

## 四判断题

### 1. 违反它的代价是什么？

用“失败概率 × 失败伤害”判断硬度。不可逆或高代价后果才进入 constraint；可逆、低代价事项进入 judgment criterion，或直接省略。每个绝对词都必须能指出具体失败模式。

### 2. 模型能从环境自行推断吗？

技术栈、目录结构和局部风格通常可现场推断，重复写入只会制造漂移。无法推断的历史原因、团队口径和隐藏风险才写，并用 why 解释。

### 3. 在什么范围内成立？

把规则放在成立的最小作用域：全局、项目、任务族或本次 run contract。作用域过大会制造未来冲突，作用域过小则无法稳定重读。

### 4. 能用结构而不是文字表达吗？

优先把自然语言升级为类型、枚举、verifier、sandbox、deny rule、只读凭证或 proxy。若没有可执行 mechanism 与故障注入证据，就不能标记 physical，只能标记 audit_only。

## 表达形式阶梯

```text
文字规则 < judgment criterion < 接口结构 < success criterion < physical mechanism
```

Judgment criterion 提供现场判据而不预填结论；接口结构用类型和枚举消除无效状态；success criterion 绑定验收物和独立 verifier；physical mechanism 让违规在系统层不可发生。越靠右越不依赖模型记住文字，但也越需要真实实现和核验。

## Run contract 编译词汇

| Boundary package | Run contract |
|---|---|
| hard boundary | `constraint` |
| judgment standard | `judgment criterion` |
| acceptance artifact | `success criterion` |
| mechanization | `physical` 或 `audit_only` |
| mutation scope | `allowed_mutations` |
| stable evidence source | content-bound `context_sources`、`preflight`、`postflight` |
| explicit user limit | 可选 `budget`，保留 user-provided provenance |

下游必须保留这组语义，不得把判断标准降成泛泛建议，也不得把 audit-only 文字约束升级成物理承诺。

## 反通胀自检

- 绝对词盘点：每个必须、绝不、always、never 是否都有高代价失败模式？
- 例外检查：规则在合理场景中是否存在真实例外？有则加限定或降级。
- 误读测试：善意执行者会如何读歪？补清 observable rule，不补操作步骤。
- 冲突扫描：与相邻作用域的规则是否冲突？
- 逐行删测：删除后不会提高失败概率的文字直接删掉。
- 物理性核验：没有 mechanism 和 verifier 的约束是否都诚实标为 audit_only？

## 场景分发

| 场景 | 输出 |
|---|---|
| 无人值守或长任务 | boundary package，交给 goal-condition 编译、确认并选择 runtime adapter |
| Spec 或设计文档 | 约束章节 + judgment criteria + success criteria |
| 团队规则 | 落到成立的最小配置层，并附来源与 verifier |
| 交互式派发 | 直接使用 boundary package 作为 prompt 的边界段 |

定稿时只交付边界语义和证据来源。具体 launcher、模型、reasoning effort 和权限选项不属于 boundary package。
