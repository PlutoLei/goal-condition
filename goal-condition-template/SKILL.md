---
name: goal-condition
description: Claude Code goal 模式（/goal）completion condition 起草工作台，也是「边界包 → condition → 无人值守执行」这条链的编排入口。四步协议：判输入形态（给的是任务描述就先接 boundary-design 产边界包）→ 按官方骨架起草（注入本项目分线验证锚点 + 铁律库，硬数字现场实测）→ condition 弹回会话附 6 项自检表等用户验证 → 用户明确确认后才交付（pbcopy 或就地起后台 goal 进程）。Use whenever the user wants a condition for goal mode or an unattended long task — 触发词：写 goal condition / goal 条件 / 帮我写 condition / goal 模式 / 长任务条件 / 无人值守跑 / unattended run。Even if the user just says "这个任务丢给 goal 模式跑" or mentions /goal, use this skill — do NOT freelance a condition without it.
---

# goal-condition — /goal 完成条件起草工作台

> **这是模板。** 下面「分线验证锚点表」与「铁律库」两节是空壳 + 填写指南，
> 装到你项目的 `.claude/skills/` 后必须先填成你自己的内容，否则本 skill 只是
> 一套没有弹药的流程。填法见每节的说明。

## 为什么值得一个协议

goal 模式的 evaluator **只看 Claude 已经表面化在对话里的内容**——所以 condition 里必须
显式要求把证据打进回复。condition 写宽 = 提前假完成；写窄 = 无限空转烧 token。长任务的
成败全押在起草这一步。

> ⚠️ **这条是经验性假设，不是官方契约**（2026-08-05 异源核实）：「evaluator 默认 Haiku」
> 有实测支撑（跑一次 `/goal` 后 result 的 `modelUsage` 里确有 `claude-haiku-4-5`）；但
> 「不跑命令、不读文件」在 `claude --help` 与 `/goal` 用法里都查不到任何行为契约。按它设计
> 是安全侧（多打证据没坏处），但**别对外把它当官方保证引用**，也别指望它跨版本稳定。
另外 condition 同时是第一个 turn 的任务指令——要带足任务语境（做什么、在哪个仓、什么范围）。

## 四步协议（顺序不可跳）

### 第 0 步：判输入形态（决定要不要先接 boundary-design）

看用户给的是什么：

- **给的是边界包**（有硬边界 / 判断标准 / 验收物 / 资源边界这些字段）→ 直接进第 1 步，
  字段对应关系：硬边界 → `Constraints`，验收物 → `verified by`，资源边界 → `or stop after N turns`。
- **给的是任务描述**（「帮我把 X 跑一下」「派个 agent 做 Y」）→ **先 invoke `boundary-design`
  产出边界包再回来**。别跳过：不经判别直接起草，会把用户口述的约束照单全收写进
  Constraints，而实测反复表明**大部分口述约束在项目里已有落点**（测试守护 / README 专节 /
  物理机制 / CLAUDE.md），重写一遍就是通胀；真正该写的往往是任务本身的歧义
  （例：「归因」与「修复」的边界）。

### 第 1 步：起草

用官方骨架，默认英文单段（对齐官方示例、避免多行粘贴歧义；用户要中文就中文）：

```
<可测量终态>, verified by <Claude 必须在输出中表面化的证据>.
Constraints: <命中线的铁律 + 范围约束>.
Or stop after <N> turns.
```

起草时做两次查表 + 一次实测：

1. 查「分线验证锚点表」——用真实命令 / 路径 / 数字位置，不写泛泛的 "tests pass"
2. 查「铁律库」——任务命中哪条线，该线铁律全部写进 Constraints
3. **实测核对将写进 condition 的每个硬数字与路径**——锚点表给的是入口不是真值：测试基线数、产物行数、文件 / checkout 是否存在、脚本当前的剔题 / 拒绝覆盖行为，起草前逐一跑一遍。核不上就把差异摊给用户，不带着过期数字起草。凡是会随代码演进漂移的计数，锚定「脚本自打印的计数行 + 公式校验」而不是死数字——写死旧产物形状是 condition 的头号死法。

🔴 **走出口 B（就地起进程）时，Constraints 必须固定追加禁嵌套子句**：

```
; this run is itself an unattended goal execution — do NOT compile another
condition, do NOT spawn a nested `claude -p "/goal ..."`, and do NOT wait for
user confirmation (there is no interactive user in this process).
```

失败模式（2026-08-05 异源核实）：`claude -p` 是 `--print` 语义——**打印一次就退出**，
子进程里没有可交互的用户。若子会话再命中本 skill 的触发词，它会走到第 2 步与
CHECKPOINT，然后卡在一个永远等不到的确认上。把禁嵌套写进 Constraints 是因为那是
子会话第一个 turn 必读的任务指令；写在本文件里子会话不一定读得到。

N 的取法：预估 turn 数 × 2；复杂任务 30–50，小任务 10–15。
特大任务不写巨型条件，拆成多个接续的 goal（每阶段一个 condition）。

⚠️ **N 给宽一点，否则终止原因不可区分**（2026-08-04 实测）：一次测试跑 N=15，
结果 `num_turns` 正好 15 而 `subtype=success`——**判完成与撞上限在返回里长得一样**，
事后无法断定报告是做完了还是被逼着收尾。宁可给到预估的 2–3 倍，让 turn 数明显低于
上限，这样「贴着上限结束」本身就成了一个可读的告警信号。

### 第 2 步：会话内验证（闸门）

把 condition 放进代码块弹到会话里，附 6 项自检表逐项标注通过与否：

| # | 自检项 |
|---|---|
| 1 | 终态可测量（退出码 / 具体数字 / 文件存在），无 "works well" 类模糊词 |
| 2 | condition 显式要求把验证证据（命令输出摘要行）打在回复里——evaluator 只能看 transcript |
| 3 | Constraints 覆盖命中线的全部铁律 |
| 4 | 有 `or stop after N turns` 兜底 |
| 5 | 完全自含：无「按之前说的」类引用（compaction 会吃掉被引用消息） |
| 6 | 长度受控（**自定预算非 CLI 限制**：`claude --help` 查不到任何 condition 长度约束，4000 字符是本协议自设的上限，防的是 condition 长到 evaluator 抓不住重点，不是防报错） |

### 🔴 CHECKPOINT · 🛑 STOP

**用户没有明确说 OK / 确认之前，禁止执行第 3 步的任何一个出口**——pbcopy 不行，起后台
goal 进程更不行。用户原话带「给我 pbcopy」「直接跑」「一键起」也一样：那是对**交付方式**
的指定，不是跳过闸门的授权。用户改一版就重弹一版再验证。

### 第 3 步：确认后交付（两种出口，用户选）

**出口 A — 交给用户自己跑**（默认）：

```bash
printf '%s' '<condition>' | pbcopy   # printf 保证无尾随换行
```

- 交互式：先 Shift+Tab 切 auto mode（goal 只管何时停、不管权限，不切会卡在工具确认）→ `/goal ` + 粘贴
- 中途查看 / 停止：`/goal`（状态）/ `/goal clear`

**出口 B — 就地起后台进程**（用户明确要「直接跑」时）：

```bash
COND=$(cat <condition 文件>)
cd <目标工作目录> && claude -p "/goal $COND" \
  --permission-mode auto --output-format stream-json --verbose > <日志>.jsonl 2>&1
```

用 `run_in_background` 起，别前台阻塞。观察要点（2026-08-04 实测）：
- 开头几十行可能全是 `hook_started` / `hook_response`，**不代表卡住**。（本机实测：不加
  `--include-hook-events` 也照样出现了 16 条 hook 事件——该 flag 存在但并非 hook 事件出现的
  必要条件，本机装了 hook 才是。别据此判断进度。）
- 过滤实质事件：`type=assistant` 的 text / tool_use，和末尾 `type=result`
- `result` 里看 `subtype` / `num_turns` / `is_error` / `total_cost_usd`
- **验完成不能只看 result**：还要独立核对终态产物存在、以及边界有没有被守住
  （被 flag 的文件 mtime 有没有变、有没有多建文件、有没有产生 commit）

**出口 B 不绕过 CHECKPOINT** —— 仍然是「弹 condition + 自检表 → 用户点头 → 才起进程」。
自动化的是编译与启动，不是判断。理由：condition 写错的两种后果（提前假完成 / 无限空转）
**都只有跑完才发现**。实测一次只读任务的测试跑花了 7.6 分钟 / USD 3.69。

⚠️ **`--permission-mode auto` 不是「全自动放行」**（2026-08-05 异源核实纠正）：它是一套带
allow / soft_deny / hard_deny 判据的分类器（`claude auto-mode defaults` 可打印全文规则），
与 `bypassPermissions` 是 `--permission-mode` 下并列的不同取值，危险操作照样会被拦。
**别拿「反正 auto 全放行」当保留 CHECKPOINT 的理由**——auto 兜得住「误操作」，兜不住
「方向错」，而 condition 写错正属于后者，这才是闸门不能省的真实理由。跑完必看 result 里的
`permission_denials`：非空说明有动作被拦下、产物可能不完整，别当成功收工。

## 分线验证锚点表

> **填写指南（装好后先做这件事）**：每条「线」= 你项目里一类会被反复派活的工作流。
> 每行填**可直接执行的真实命令 + 产物落点 + 当前基线数字**，不要写 "跑测试"。
> 数字后面标注口径日期，因为它会漂移。CI 不可用的线要写明，否则把 CI 写进门禁
> 会导致 condition 永远判不了真。**本表是锚点唯一权威源，锚点过期就更新本表。**

| 线 | 可验证锚点 |
|---|---|
| `<线名，如：单元测试线>` | `<repo 根 pytest 命令>`，基线 **<N>** tests 全绿（<YYYY-MM-DD> 口径；派发前跑 `--collect-only -q` 复核计数）；CI 可用性=<可用/不可用及原因>；仓路径 `<绝对路径>` |
| `<线名，如：某评测线>` | `<runner 脚本路径>`；报告落 `<产物目录>`；过线判据 `<具体检查>` |
| `<线名，如：构建线>` | `<build 命令>` + `<test 命令>`；交付形态 = <PR / 直推 / 产物文件> |

**填表时的两个坑**：
1. 「exit 0 即过」不够——脚本可能因路径失效而 SKIP 且 exit 0，静默空转还判通过。
   过线标准写成「exit 0 **且**输出不含 SKIP」。
2. 别锚死数字，锚「脚本自打印的计数行 + 公式校验」，否则代码一演进 condition 就误报。

## 铁律库（Constraints 素材）

> **填写指南**：只装**违反了会造成不可逆或高代价后果**的约束，且每条要说得出具体失败模式。
> 可逆的、低代价的、模型看代码就能推断的，都不要往这里塞——铁律库通胀会让模型分不清
> 哪条是真红线。能用物理机制拦住的（只读连接 / hook / permissions）优先做成机制，
> 这里只留一行指针。

| 类别 | 填什么 |
|---|---|
| 数据安全 | 生产数据库 / 外部服务的只读或禁写约束，及其**机制化状态**（有 wrapper 就指过去） |
| 算法与口径 | 不许擅自改的公式 / 权重 / 阈值，以及「动了必须人工报备」的边界 |
| 交付纪律 | 分支命名、能不能直推、交付形态是 PR 还是产物 |
| 数据泄漏护栏 | 评测类项目里禁止读取的真值字段等 |
| 通用 | 不碰正交代码；不删原有死代码 |

## 常见失败模式（起草时对照）

| 症状（触发条件） | 一线修复 | 仍失败兜底 |
|---|---|---|
| evaluator 提前判完成（条件太宽） | 加范围约束："and no files modified outside X" | 终态升级为互斥硬指标组：数字 + 文件存在 + git 状态三重 |
| 无限空转（条件太窄 / 要求完美） | 放宽到可达标准，压 turn 上限 | 拆成多个接续 goal，每阶段一个 condition |
| 永远判不了真（证据没表面化） | condition 里显式要求 surface 命令输出摘要行 | 把验证命令本身写进 condition 步骤，agent 不跑就不可能满足 |
| 硬数字核不上（基线漂移） | 重新实测，改用脚本自打印计数 + 公式校验 | 该数字从终态降级为报告字段，差异摊给用户拍板 |
| 行为漂移（条件不自含） | 去掉一切会话引用，写死绝对路径 / 分支 / 基线数 | 假设目标会话在陌生目录启动，重读一遍 condition 是否仍可执行 |

## 反例黑名单（绝不做）

- 未经用户确认就交付——pbcopy 或起后台 goal 进程都算；用户原话带「给我 pbcopy」「直接跑」也不是授权
- 把旧产物形状（行数 / 计数）当不变量硬编码进终态
- 写 "tests pass" / "works well" 类泛语而不锚定具体命令与数字
- 忘写 `or stop after N turns`
- 让无人值守任务重做人工 / 半人工判定产物（rubric verdicts 类）——评测口径只能复用，不能让 agent 重判
- 把 CI 写进门禁而不查锚点表的 CI 可用性——CI 不可用的线写了就永远判不了真
- 拿到任务描述直接起草，跳过第 0 步的边界判别——照单全收口述约束＝通胀
