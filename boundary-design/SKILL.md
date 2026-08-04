---
name: boundary-design
description: 为一个 goal 设计边界体系，产出「边界包」：硬边界 + 判断标准 + 验收物 + 资源边界各就各位，把「详细操作手册」式任务描述换成「goal + 边界」，其余空间交给模型判断。Use when 用户要为某个目标/任务线/长任务/agent 会话设约束——触发词：定边界 / 设红线 / 写约束 / 圈范围 / 立规矩 / boundary design / guardrails；要把任务派给 agent 又不想写步骤手册；写 spec 的约束章节；制定团队纪律、CLAUDE.md 规则或新 skill 的约束条款；或说「这个任务丢给 goal 模式跑」需要先定制条件（本 skill 产边界包 → goal-condition 编译）。Also use when another skill needs the boundary vocabulary（四判断题 / 表达形式阶梯 / 边界包）。即使用户只说「帮我管住 agent 别乱来」「怎么让它不越界」「给它多少自由度」也应触发。
---

# boundary-design — 为 goal 设计边界包

## 为什么是边界不是手册

Boris Cherny（Claude Code 创造者）给过最简式：*"Describe the task, describe the
guardrails, describe the exit criteria, and then just go let the model cook."*
对强模型，过度规定步骤会把它锁进你的探索空间；互相冲突的规则则消耗推理预算去消解
（Thariq：*"Claude must think more carefully about these overlapping and conflicting
messages"*）。所以边界设计的产出不是更多规则，而是：**少而真的硬边界 + 带理由的判断
标准 + 可验证的完成判据**，剩下交给模型。

## 边界包（输出格式）

```
GOAL: <一句话，带语境：哪个仓 / 什么范围 / 为什么做>

硬边界（guardrails，目标 ≤5 条）:
  - <绝对语气；每条必须对应一个说得出口的高代价失败模式>

判断标准（软约束，每条带 why）:
  - <给现场可观测的判据来源，不给结论>  (why: <理由>)

待机制化（能物理拦截的别靠文字）:
  - <hook / permission / 只读连接 / 枚举 / 测试> ← 现状差在哪，谁去建

验收物（exit criteria）:
  - <可测量终态 + 需要表面化的证据；测试 / rubric / 参考实现优于文字描述>

资源边界: <turn 数 / token / 时间 / 预算上限>

放层清单: <每条边界 → 它成立的最小作用域（见判断题 3）>
```

场景不需要哪个字段就删掉哪个字段，但「硬边界为空」应当是常态而非例外——大多数任务
只需要判断标准和验收物。

## 四判断题（对每条候选约束依次问）

**1. 违反它的代价是什么？→ 定硬度**
官方风险公式：失败概率 × 失败伤害。不可逆 / 高危（删数据、写生产、对外发布、花真钱）
→ 硬边界，绝对语气，条数稀缺。可逆 / 低代价 → 判断标准，或不写。
门槛原文：*"Stop writing 'never do X' unless you have a specific, demonstrable
failure mode that the model can't reason its way out of."*

**2. 模型能从环境自行推断吗？→ 定写不写**
能推断（技术栈、目录结构、代码风格）→ 不写，写了是噪音还可能与现场冲突。
不能推断的 gotchas（隐性约束、历史原因、团队口径）→ 写，并带 why。
识别 gotcha 的自问（Thariq）：*"What's so obvious I'd never write it down, but would
recognize it if I saw it?"*

**3. 在什么范围内成立？→ 定放层**
永远 + 全局 → 全局配置层；项目特有 → 项目 CLAUDE.md；只在某类任务出现 → skill
（按需加载）；只在本次任务 → prompt / reference。放进成立的最小作用域。
放错层 = 未来冲突源，而冲突的后果是随机的：*"if two rules contradict each other,
Claude may pick one arbitrarily."*

**4. 能用结构而不是文字表达吗？→ 定形式（见表达阶梯）**

## 表达形式阶梯（能往高处走就往高处走）

```
文字规则 < 判断标准 < 接口结构 < 验收物 < 物理机制
```

- **文字规则**：最弱。官方定性：CLAUDE.md 是 *"context, not enforced configuration."*
- **判断标准**：给现场可观测的参照物（"match the surrounding code"）。这是把规则换成
  判据来源，不是换成模糊。
- **接口结构**：枚举 / 参数 / 类型本身表达约束（官方例：Todo 状态枚举 pending /
  in_progress / completed + "keep one item in_progress"——不用一个示例）。
- **验收物**：测试 / rubric / 参考实现 / HTML 原型定义「什么算对」。强度四档：
  prompt 内自查 → /goal condition（独立 evaluator）→ Stop hook（脚本级阻塞）→
  verifier subagent。
- **物理机制**：permissions.deny / PreToolUse hook / sandbox / 引擎级只读连接——
  违反在系统层面不可能。官方：*"To block an action regardless of what Claude decides,
  use a PreToolUse hook instead."*

阶梯高处的边界不占上下文、不怕被忽略、不需要被「记得」。文字规则只该承载阶梯上面
四层装不下的东西。

## 场景分发（边界包的出口）

| 场景 | 出口 |
|---|---|
| 无人值守 /goal，项目有 condition 编译 skill（如配套的 goal-condition） | 边界包交给该 skill 按其协议编译、验证、交付 |
| 无人值守 /goal，项目没有 | 按官方骨架自行编译：`<可测量终态>, verified by <表面化证据>. Constraints: <硬边界>. Or stop after <N> turns.`；写进 condition 的每个硬数字先实测；建议该项目参照 goal-condition 建「锚点表 + 铁律库」 |
| spec / 设计文档 | 边界包落为约束章节（验收物列 rubric） |
| 团队纪律 / CLAUDE.md / skill 条款 | 落为对应层的补丁；落笔前必过反通胀自检 |
| 交互式派任务（subagent / 同事 / 另一会话） | 边界包直接作 prompt 段 |

## 反通胀自检（边界包定稿前过一遍）

- **绝对词盘点**：每个「绝不 / 一律 / always / never / MUST」都能指出对应的真实失败
  模式吗？指不出 → 降级为判断标准。绝对词是稀缺资源：用滥了模型无法分辨哪条是真红线。
- **90/10 检查**（Cat Wu 的教训：*"90% true, but there's a real 10% of cases where
  it's not true"*）：这条规则在一成场景下是错的吗？是 → 加限定条件或降级。
- **误读测试**（Cat Wu）：*"think about the ways in which it could be misinterpreted
  by a well-intentioned human"*——善意的人会怎么读歪它，模型就可能怎么执行歪。
- **冲突扫描**：与目标层的上、下各层已有规则对过了吗？
- **逐行删测**（官方）：*"Would removing this cause Claude to make mistakes?
  If not, cut it."*
- **正向优先**：正例比禁令有效（官方：*"Positive examples… tend to be more effective
  than instructions about what not to do"*）；禁令还会被字面执行出漏报。

## 边界体系要随模型代际重审

每个约束都编码着「模型自己做不到什么」的假设，官方建议对这些假设做压力测试——
Claude Code 自己删掉 80%+ 系统提示词而评测无可测量下降。存量边界的消融法（Boris）：
全删，逐行加回，看每行的实际影响；他建议每 ~6 个月对 CLAUDE.md / skills / hooks
做一次从零重建。

## 邻居分工

- **brainstorming** 产设计与 spec；本 skill 为其补约束章节。
- **grilling 系** 压测你已有的想法；本 skill 生成边界体系——先生成后拷问是好组合。
- **goal-condition**（本仓配套模板，装成项目级）是 /goal 场景的下游编译器；
  本 skill 做上游判别与定制。
- 建议自建一份 `references/badcases.md` 正反例库：**用你自己项目里的真事故**，
  比合成用例值钱得多。本 skill 的原始案例库含所属组织的内部信息故未随仓发布，
  但攒法在 README 里写了。
