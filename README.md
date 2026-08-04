# boundary-design

给 agent 派活时，别写操作手册，写边界。

这是两个配套的 [Claude Code skill](https://code.claude.com/docs/en/skills)：**boundary-design** 判断一件事该管什么、不该管什么、该管到什么形式；**goal-condition** 把结论编译成 `/goal` 无人值守任务能吃下的完成条件。

## 为什么

Boris Cherny（Claude Code 作者）给过最简式：*"Describe the task, describe the guardrails, describe the exit criteria, and then just go let the model cook."*

问题是「guardrails 该写什么」本身没人教。实践里大多数人的默认动作是**往上加**——想到一个坑就加一条规则，于是 CLAUDE.md 越来越长、绝对词越来越多，模型反而分不清哪条是真红线。而过度规定步骤会把强模型锁进你的探索空间，互相冲突的规则则消耗推理预算去消解。

boundary-design 的主要动作是**砍**：对每条候选约束问四个问题，判断它该不该存在、该存在于哪一层、该用什么形式表达。用完之后规则变多了，多半是用错了。

## 两个 skill

### boundary-design

输入一个目标加背景，输出一张「边界包」：

```
GOAL: <一句话，带语境>
硬边界（目标 ≤5 条）:      每条必须对应一个说得出口的高代价失败模式
判断标准（每条带 why）:     给现场可观测的判据来源，不给结论
待机制化:                  能物理拦截的别靠文字
验收物:                    可测量终态 + 需要表面化的证据
资源边界:                  turn / token / 时间上限
放层清单:                  每条边界 → 它成立的最小作用域
```

核心是**四判断题**（代价定硬度 / 可推断定写不写 / 作用域定放层 / 可机制化定形式）和**表达形式阶梯**：

```
文字规则 < 判断标准 < 接口结构 < 验收物 < 物理机制
```

能往高处走就往高处走。阶梯高处的边界不占上下文、不怕被忽略、不需要被「记得」。

有一点反直觉但很重要：**「硬边界为空」应该是常态**。绝大多数任务只需要判断标准和验收物。

### goal-condition（模板）

`/goal` 的 evaluator 不跑命令、不读文件，只看已经表面化在对话里的内容。条件写宽了提前判假完成，写窄了无限空转烧 token。这个 skill 用三步协议管住它：起草（查锚点表 + 铁律库 + 实测每个硬数字）→ 弹回会话过 6 项自检 → **用户明确确认才 pbcopy**。

仓里这份是**模板**：锚点表和铁律库是空壳加填写指南，装到你项目里要先填成你自己的内容。原版含所属组织的内部信息，未随仓发布。

## 安装

```bash
# 全局（所有项目可用）——方法论适合放这层
cp -r boundary-design ~/.claude/skills/

# 项目级——goal-condition 装这层，因为它的锚点表是项目特有的
mkdir -p <你的项目>/.claude/skills
cp -r goal-condition-template <你的项目>/.claude/skills/goal-condition
```

两个 skill 都是自动触发。说「定个边界」「设条红线」「这活丢给 goal 跑」之类就会起来，也可以 `/boundary-design` 直接叫。

## 关于案例库

原版 skill 带一个 `references/badcases.md` 正反例库，因含内部信息未发布。**强烈建议你自建一份**，用你自己项目里的真事故——比任何合成用例都值钱。几个攒法：

- **锚点腐烂**比规则通胀更高发。迁移、离职、重构之后，文字层的路径 / 组织名 / 人名 / commit hash 没人更新，而失效是静默的。做过一次全量审计的话，把失效指针的比例记下来。
- **验收物自己也会腐烂**。见过一个快速检查脚本因为旧路径而 SKIP 且 exit 0，被清单判为「通过」，静默空转十天。所以过线标准要写「exit 0 且输出不含 SKIP」。
- **物理机制的失败是静默的**。文字规则失败是「被忽略」，人看得见；物理机制失败是「作用域写错」——它照常拦截，只是拦错了对象，一声不吭。往阶梯上层走不是免费的，要额外验作用域。
- **检索作用域假阴性**。判断「这条约束项目里有没有落点」时，grep 返回空不会告诉你是真没有还是没搜到。产边界包前把边界载体逐类扫一遍：README、代码注释、测试名、配置、CLAUDE.md、物理机制。跳过任何一类都可能把已写好的当缺失的重写一遍——而重写正是通胀的来源。

  这类失误一天之内可以复发四次：限定了错的文件类型、shell glob 没展开、关键词表漏了最关键那个词、以及用了 GNU 的 `find -newermt` 而 BSD find 静默返回空。共同形态是**工具照常返回、退出码 0、零报错**，只是覆盖面不对。防法是先拿一个已知必然命中的对照样本验证检索方法本身，再信它的空结果——验证脚本静默失效比被验对象出错更危险。

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

官方从未使用 "boundary design" 这个词，对齐的官方术语是 degrees of freedom / right altitude / access boundaries。

## 证据强度

诚实交代：这两个 skill 经过 4 个合成用例的 eval（with 20/20 vs baseline 16/20）和一次真实任务 dogfood。**那个 eval 不作强证据**——用例与判分同出一个生成器（LLM 自评，无独立真值路径）、未注入已知缺陷验非恒绿、baseline 方差大于组间差的一半。真实 dogfood 的结论反而更有意思：口述的 4 条业务约束经现场核实**全部已有落点，边界包的文字层应该是空的**。

在维护良好的项目里，边界设计的主要工作是**核实与指路，不是撰写**。

## License

MIT
