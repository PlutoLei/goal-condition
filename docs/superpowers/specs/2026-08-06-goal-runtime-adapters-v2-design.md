# goal-condition runtime adapter v2 设计（实测机制对齐）

状态：v2——已过四源审核 + 7 spike 实测折回（2026-08-06）；待 Plan 2 实现

日期：2026-08-06

## v0→v1 修订说明（四源审核结果）——关键反转

四源（3 lens + Codex 事实核查）+ 双异源证伪（Codex/DeepSeek 双票，CONTESTED 率 2/13）。裁决：10 条 CONFIRMED 全部批准，2 条 CONTESTED 按交集收口，1 条双杀进附录。

1. **状态写入非权威**（二进制 SQL 证据）：`thread/goal/set` 经条件 CASE，「拉回 active」可被粘滞/预算分支静默吞且 RPC 不报错 → 所有状态写入后强制 readback 比对目标态，不等即终局；续跑同请求抬 tokenBudget（§4/§5）。
2. **S1 验错方向** → 拆 S1a/S1b（§8）。
3. **finalize 橡皮章**：模型已写 complete 时控制器 set 为 no-op、readback 无 provenance → set 带 goal_id 条件 + readback 与 set 返回 envelope 逐字段绑定（§4/§3 D5）。
4. **轮询永挂**：无 deadline、paused/usage_limited 无处置 → wall-clock deadline + 六态逐态处置表，paused/usage_limited 不自动 resume（绕限流=触「无人值守禁旁路」铁律）（§4/§6）。
5. **exec 回退硬冲突**：codexFinalization 硬要两条 goal 证据 → 回退含状态机降级开关（codex 分支降为 Claude 式双通道），属行为变更入 §7（§8）。
6. **孤儿续轮**：controller 死而 daemon 活无处置 → daemon 租约（controller 心跳+TTL，失联自动 clear）（§5/§6）。⚠️ 2026-08-06 终审：这条决策的后半段「失联自动 clear」**未落地也无法落地**（daemon 不知道租约存在），实现里租约只拦下一次 launch；§4/§5/§6 已改为如实描述，此处保留原始决策文字仅作沿革记录。
7. **hook 保护非物理**：Write/Edit deny 挡不住 Bash 旁路 → S5 fault injection 必含 Bash 旁路探针；hook 结论显式非证据（§5/§8）。
8. **goalRpc 独占无机制** → 新增 S6 spike 实测 sandbox 能否连 sock；挡不住则 finalize receipt 降 audit_only（§5/§8）。
9. **resume hook 静默缺席** → resumeSpec 强制复用 --settings；hook 运行计数入 state，postflight 校验次数 ≥ attempt 轮数（§5）。
10. **投影吃掉 fail-closed**：未知 key 改 fail-closed（21-key 全集校验）；版本闸改 exact/已验证 allowlist（§5）。
11. **hook 执行器是新组件**（CONTESTED 收口）：明示达标语义、多红收集不抛、与 preflight 的 captureCommand（不变性语义、非零即抛）无复用关系（§5）。
12. **外环重入语义**（CONTESTED 收口）：通道结构不改；红项分类基于控制器自有原始 verifier 结果（不解析 reasons 字符串），每 attempt 状态机重入、绑定同一 runBinding + attempt 序号（§6）。

双杀进附录：「D3 收益依赖常驻控制器不兑现」——双异源同锚（§4 已明写 controller 持有 daemon 生命周期并轮询）；残留建议已吸收：§4 补轮询姿态参数。

## v1→v2 修订说明（7 spike 实测折回）

spike 阶段（双流水线并行，每个 spike 经 implementer→review→fix loop）用真实行为检验了 v1 的实测假设。完整决策矩阵见 `docs/superpowers/spikes/2026-08-06-goal-runtime-adapters-v2-results.md`。**路径判决：Codex app-server 全量与 Claude Stop hook 两条路径均实测成立，回退均未触发。** 相对 v1 的实质修正：

1. **KR3 被方向性反证**（最重要）：v1 第 7 条据四源审核**双异源 CONFIRMED** 判「deny 挡不住 Bash 旁路、hook 保护非物理」。S5 实测**反证**——deny 对简单 Bash 重定向（`printf > hook`）**也有效**（permission_denials 实录）；hook 保护比 v1 定性的强，不再是纯观测防线。精确上限（语义级 vs 字面）INCONCLUSIVE 待补测（§5/§8）。
2. **finalize 归因改字段**：v1 第 3 条用 goal_id + updated_at_ms 逐字段绑定。S1a 实测 **goal_id 在 RPC 层不可得**、updatedAt 秒级撞值 → 归因改 `threadId`+`updatedAt`+控制器单调序列号（§3 D5）。
3. **set 返回真实 status**：v1 第 1 条「set 后强制 readback」。S2b 实测 set 响应**自身**即如实返回被拒 status → 改「读 set 返回的实际 status」（§4/§5）。
4. **起首轮 turn/start**：goal set 本身不驱动执行，需 `turn/start` 推入真实 turn；续轮近瞬时链式（~13ms）、订阅 turn/started·turn/completed（§4/§5）。
5. **ephemeral 约束**：goal 必须挂非 ephemeral thread（ephemeral 拒 goal RPC -32600）（§4）。
6. **S4 因果链→resumeSpec**：inject 不独立驱动执行 → 续跑必配 turn/start；inject method=`thread/inject_items`、items=message 形状（§5）。
7. **S3 死循环风险**：hook reason 与 objective 冲突致模型罢工 → 规范 hook reason + max_turns 处理；block 协议=JSON decision（非 exit 2）（§5）。
8. **S6 receipt 可信**：sandbox seatbelt syscall 层挡住执行器 connect sock → finalize receipt 可信（带 substitute caveat：替代进程证据、未在真实 daemon sock 交叉验证）（§5/§8）。
9. **auth-copy 安全模式**：真实 turn 需认证 → 隔离 CODEX_HOME 只读复制 auth.json + 独立 mkdtemp + 信号安全清理（§5 新小节）。

生死闸坐实：Codex S2b 三坐实点全真、Claude S3 闭环成立。回退路径（exec 单发 / 裸 -p）均未触发。

## 1. 背景与结论

2026-08-06 对 Claude Code 与 Codex 的 goal 机制做了双源实测调研（官方文档 + 本地二进制/协议勘察），发现 2026-08-05 设计的两处地基悬空：

- `references/adapters/codex.md` 要求主会话调用 `update_goal`/`get_goal`——它们是**线程内模型侧 tool**，外部编排器没有调用通道，该指令按字面无法执行。外部编排的真实表面是 app-server JSON-RPC：`thread/goal/set|get|clear` 与 `thread/goal/updated|cleared` 通知。
- `references/adapters/claude.md` 假设把完整 contract 内联进 `/goal` condition，但 `/goal` 条件上限 4000 字符，且续轮判定由小模型（默认 Haiku）担任、`disableAllHooks` 会整体禁用。

本设计决策：**Claude 侧弃用 `/goal` 包装，直用其底层机制（session-scoped Stop hook）自建确定性续轮自检；Codex 侧走 app-server JSON-RPC 全量对接原生 goal 对象（用户知情选择）；两侧共用有限自动续跑外环（N=2）**。协议核心（contract 格式、canonical hash、snapshot、controller-owned 证据通道、独立 postflight）不动。

## 2. 调研事实基座

关键事实与来源（本节自含全部设计承重项；协议 schema 可按文中命令随时重新生成核对）：

### Claude Code `/goal`（v2.1.139 引入；本机 2.1.223）

- `/goal` 是 session-scoped **prompt-based Stop hook 的包装**：每轮结束由小模型（默认 Haiku，`ANTHROPIC_DEFAULT_HAIKU_MODEL` 可换）判条件，未满足带原因自动续轮。来源：code.claude.com/docs/en/goal.md。
- headless 姿态 `claude -p "/goal <condition>"`，无专属 flag；condition ≤ 4000 字符。
- 无外部状态查询 API；turn/time 限制只能写进条件文本；`disableAllHooks`/`allowManagedHooksOnly` 使 `/goal` 不可用；goal 不改变权限。
- `claude -p --output-format json` 的 result envelope 实测（2.1.223）含 21 个 key，其中 `subtype:"success"`、`is_error:false`、`terminal_reason:"completed"`、`permission_denials:[]`。⚠️ SDK 文档列出的 `terminal_reason` 取值集不含 `"completed"`（列 `success`/`max_turns_reached` 等）——字段取值有文档–实现漂移，exact-match 判定必须钉住实测版本并盯 changelog。
- `claude -p --resume <session_id>` 存在（本地 `--help` 实测），是外环续跑载体。

### Codex goal（codex-cli 0.128.0 引入，rust-v0.128.0 release notes；本机 0.146.0-alpha.9.2）

- 五层实现：sqlite 持久化（`~/.codex/goals_1.sqlite`）/ app-server API / 模型侧 tool / runtime 续跑 / TUI。官方文档页未覆盖，仅 release notes。
- `create_goal`/`get_goal`/`update_goal` 是**线程内模型侧 tool**；`update_goal` 运行时限制只允许模型标 complete/blocked。
- 外部编排唯一表面：app-server JSON-RPC `thread/goal/set`（params `{threadId, objective?, status?, tokenBudget?}`，status 收完整枚举）、`thread/goal/get`、`thread/goal/clear`、通知 `thread/goal/updated|cleared`。协议 schema 可用 `codex app-server generate-json-schema --experimental` 重新生成。
- ⚠️ **`thread/goal/set` 的状态写入不是无条件直写**（二进制 SQL 一手证据，2026-08-06 `strings` 提取）：UPDATE 经条件 CASE——存在「粘滞」分支（`WHEN status = ? AND ? IN (?, ?) THEN status`，保留当前态忽略请求）与预算分支（active 请求在 `tokens_used >= token_budget` 时被改写 `budget_limited`）；另存在「同请求带 token_budget」的 UPDATE 变体（可在拉回 active 时同步抬预算）。**RPC 返回成功不代表状态已按请求改变**。
- 状态集：`active|paused|blocked|usage_limited|budget_limited|complete`（**无 `in_progress`**）。一 thread 一 goal（PK），重建 goal 清零计量。
- `token_budget` 由 SQL 记账自动转 `budget_limited`（注入收尾提示，**软停不硬杀**）。blocked 阈值 = 同一阻断连续 ≥3 goal turn（提示词硬编码）。
- `remaining_work` 与 `ready_for_postflight` 是本协议自造的归一化层，非 Codex 原生——维持既有声明。
- 续跑需要活的 app-server 线程（idle 触发）；`codex exec` 有 `resume` 子命令、`--json`、`--output-last-message`、`--output-schema`、`--sandbox read-only|workspace-write|danger-full-access`（本地 `--help` 实测）。
- MCP server 与 cloud 均非 goal 表面。

## 3. 决策记录（备选与取舍）

### D1 范围

选定：adapter 文档重写 + 路由薄层（`launch.mjs` + 代码化 adapter）。范围外溢如实声明：`workflow.mjs` 与两份协议文档的同步改动（见 §7）。备选「只修文档」（根因原封）与「加验 validator 机械化」（一轮撑太满）不选；validator 体系债单开一轮（§10）。

### D2 Claude 续轮机制

选定：**自建 command 型 Stop hook**——裸 `claude -p` + 控制器生成的 hook 脚本跑确定性验收命令，红则 block 续轮。备选：
- `/goal` 压缩条件：官方机制零自建，但 Haiku 弱判官驱动循环、4000 字符压缩有信息损失、hooks 被禁即失效。不选。
- 裸 `-p` 单发：最简，但无人值守下提前停机 = 整轮作废。不选（保留为 S3/S5 失败时的回退）。
- 双轨可配：工作量翻倍且两条路径都无实战。YAGNI，不选。

理由：把「续轮判定」从弱模型换成确定性脚本，与协议「机判优先」一致；且无 4000 字符约束。

### D3 Codex 对接姿态

选定：**app-server JSON-RPC 全量对接**（用户在听取收益/代价清单后明确选择）。买到：运行中可观测（`thread/goal/get` 轮询 + `updated` 订阅）、运行中可干预（外部 pause/resume/clear，不必杀进程）、原生 token 记账与 `budget_limited` 软停、计量落 sqlite 留痕。代价：daemon 生命周期管理、JSON-RPC 管道、alpha 协议漂移风险、状态写入面的条件 CASE 语义（§2）、未实证闸（§8 S1a/S1b/S2/S6）。

备选「`codex exec` 单发 + 外环」保留为**回退路径**：若 §8 的 S1b 或 S2 打样失败，Codex 侧回退 exec 单发（`--output-schema` 强制候选终态形状、`--sandbox` 承载物理约束、`exec resume` 承载续跑）。⚠️ **回退是行为变更不是免费替换**：现行 `codexFinalization` 硬要求 `finalizationReceipt` + `runtimeReadback`，exec 单发无 goal 对象、两条证据永不可得（`nextAction` 恒返 `finalize_runtime`）——回退包含**状态机降级开关**（codex 分支降为 Claude 式双通道：候选终态 + postflightEvidence），该开关属 §7 改动清单的一部分，随本轮一并实现并测试。**【v2 实测更新】S1b/S2 已实测 PASS（见 §8 spike 实测结果），app-server 全量对接成立、回退未触发；状态机降级开关降为「未来 alpha 协议漂移的预留」，不在本轮实现主路径上。**

### D4 外环语义

选定：**有限自动续跑**。postflight 红且属「未达标」类 → 红项 diagnostic 馈入续跑，上限 N=2（adapter 常量，非 contract 字段）；「边界违规」类永不续跑（§6）。**重入语义**（四源审核收口）：通道结构与 `nextAction` 均不改——红项分类由控制器基于**自有的原始 verifier 结果**判定（它自己跑的命令，天然知道哪条红、为何红；不解析 `postflightEvidence.reasons` 字符串）；每个 attempt 是状态机的一次完整重入（同一 `runBinding`，attempt 序号入 controller state，单调递增、O_EXCL 原子写）。备选「失败即终局」（无人值守价值打折）与「预算内不限次」（无预算 contract 无上限，且把可选字段变事实必需）不选。

### D5 候选完成信号（Codex）

选定：**模型 `update_goal` 触发的状态变更 = 唯一自然信号**。goal active 时线程一 idle 就自动续轮，「安静等验收」状态不存在。两种自标分流：`complete` → 归一化为既有候选形状 `{status:"ready_for_postflight", remaining_work:false}` 进入控制器独立 postflight；`blocked` → **终局报告路径**（按 diagnostic 报告阻断证据与下一步，不进验收、不 finalize）。postflight 红（可续类）由控制器 `thread/goal/set {status:"active"}` 拉回续跑——**写入后必须 readback 比对**（§4）。备选「禁模型碰 update_goal + 控制器轮询猜测完成」更糊，不选。goal 由控制器经 `thread/goal/set` 创建；objective 文本明令禁止模型 `create_goal`（且原生「已有未完成 goal 则 create 失败」提供天然护栏）。

**finalize 可归因**（四源审核收口 + v2 实测修正）：模型自标 complete 后，控制器的 set complete 在状态维度是 no-op——finalize 证据不得只看「状态是 complete」。**【v2 实测更新】goal_id 在 RPC envelope 层不可得**（S1a schema+实测双证：`ThreadGoal` 字段为 threadId/objective/status/tokenBudget/tokensUsed/timeUsedSeconds/createdAt/updatedAt，无 goal_id/goalId），故四源审核原方案「set 带 goal_id 条件 + readback 逐字段绑定 goal_id」**在 RPC 层做不到**。修正后的归因：控制器 set complete 后，readback 与 set 返回 envelope 做 `threadId`+`updatedAt` 一致性校验；但 `updatedAt` 是秒级精度、同秒内连续 set 会撞值（S1a 实测 setActive/setComplete 两次的 updatedAt 相同=1786000451），故必须再叠加**控制器侧单调序列号**（记录这是第几次 set）作严格归因锚点，不能只判 updatedAt 等值。校验不过 → finalize 证据为 false。

## 4. 架构

```
Compile → Validate → Preview → Confirm(hash)      （不变）
→ Preflight capture（原始 baseline，全程唯一）      （不变）
→ launch.mjs 按 contract.runtime 分派：

  claude:  claude -p <contract prompt> --settings <生成的 settings>
           Stop hook（§5）：跑 postflight 命令子集，
           红→block+馈原因续轮；超 turn/时间预算→放行停机标未达
           候选终态 = result JSON 21-key 全集校验后 4 字段投影
           续跑 = claude -p --resume <session_id> --settings <同一 settings>

  codex:   codex app-server daemon start（controller 持有生命周期，
           启动即写租约：controller 心跳 + TTL。租约的作用面**只有一个**——
           拦住下一次并发 launch；TTL 到期不触发任何 clear，daemon 侧不知道
           租约存在。controller 被 SIGKILL 时 app-server 走 stdio，父进程死后
           stdin EOF 很可能让它自退，但**本轮未实测**，代码也不依赖这一点：
           过期租约同样拦 launch，出口是先跑 close 清残留）
           → initialize → thread/start（**ephemeral:false**——goal 必须挂
             非 ephemeral thread，S1a 实测 ephemeral 拒 goal RPC -32600）
           → thread/goal/set {objective, tokenBudget?}（控制器建 goal）
           → **turn/start {threadId, input:[{type:'text',text}]}** 起首轮
             （S2 实测：goal set 本身不驱动执行，需 turn/start 推入真实 turn）
             ⚠️ 一切 thread/goal/set 之后比对 **set 返回的实际 status**
             （S2b 实测：set 响应自身即如实返回被拒 status，不必额外 get readback；
             但不假定请求即生效——状态写入面是条件 CASE，见 §2）；不等 → 终局
           → 运行中：订阅 **turn/started / turn/completed** 计 turn 边界
             （S2 实测：目标未达成时服务端在 turn 完成后~13ms 内自动链起下一
             turn，近瞬时链式、非等 idle 窗口，adapter 无需自实现 idle 检测）
             + 轮询 thread/goal/get（wall-clock deadline = adapter 常量，
             超时 → 终局报告）
           → 候选信号 = 模型 update_goal：complete→不可信候选；
             blocked→终局报告（不进验收）
           → postflight 红（可续类）→ thread/goal/set {status:"active"}
             + readback 验证 + 注入红项 diagnostic 续跑；
             预算已耗尽时同请求抬 tokenBudget（SQL 存在该变体），
             抬升值须经用户确认（预算仅用户明给）
           → postflight 全绿 → 控制器 thread/goal/set {status:"complete"}
             → readback 与 set 返回 envelope 做 threadId+updatedAt+序列号
             归因（goal_id RPC 层不可得，见 §3 D5 可归因条款）

→ 控制器独立 postflight + snapshot verify（对照原始 baseline，不变）
→ Close（不变）
```

**Codex 六态逐态处置表**（无人值守）：

| goal 状态 | 处置 |
|---|---|
| `active` | 正常轮询；超 deadline → 终局报告 |
| `complete` | 不可信候选 → 控制器 postflight |
| `blocked` | 终局报告（阻断证据 + 下一步），不 finalize |
| `paused` | 终局报告并停机，**不自动 resume** |
| `usage_limited` | 终局报告并停机，**不自动 resume**——自动 resume = 绕限流，触「无人值守禁旁路」铁律 |
| `budget_limited` | 终局报告并停机；续跑抬预算须经用户确认 |

两 runtime 形状不对称是实际机制的形状，不硬求对称：Claude = 发射后黑盒 + hook 自检 + resume 外环；Codex = 活体 goal 对象全程编排。

## 5. 组件与接口

### `scripts/launch.mjs` + `scripts/lib/adapters/{claude,codex}.mjs`（新增，入公开闭包）

```
assertLaunchable(contract, probes) → {ok, reasons[]}
  probes = 控制器**事先采集并落盘**的静态观测（含采集命令与原始输出，
  存 controller state）；assertLaunchable 是纯函数，只判不采。
  通用：confirmed hash 匹配、baseline digest 已外存
  claude：生成的 settings 无 disableAllHooks/allowManagedHooksOnly；
          hook 脚本已落盘 controller state 目录（target root 之外）
          且 settings 对该路径设 **Edit** deny（`Edit(//path)` 双斜杠语法，
          `Write()` 规则已弃用）（⚠️ 【v2 实测更新，方向性反证四源审核 KR3】
          S5 实测：deny 对**简单 Bash 重定向**（`printf > hook`）**也有效**、
          被真实 permission_denials 拦截——deny 不只挡工具层，hook 保护**比
          KR3 当初假设的强**；但精确上限（语义级路径解析 vs 字面文本匹配）
          INCONCLUSIVE 待补测，故仍不宣称完全物理保证，也不再当纯观测防线）；
          claude 版本命中**已验证 allowlist**（初始 = {2.1.223}，
          新版本须重跑 S3/S5 实测后才可加入）
  codex： daemon 可达；state 目录无任何租约残留——'live'（上次 launch 还活着，
          不允许并发第二个）与 'stale'（持有者失联但它起的 daemon/goal 可能仍在，
          TTL 到期不会替你 clear）都拦，后者的出口是先跑 close；
          features goals=true；
          残留 goal 检查——daemon sqlite 中无本 controller 之外的
          active goal（上次 abort 的残留先 clear 再 launch）；
          --sandbox 模式与 contract 的 physical 约束逐条对应
          （对不上 → 降 audit_only 或停止）；**【v2 实测】S6 已定级：
          执行器 sandbox 对 sock 的 connect() 被 seatbelt syscall 层拦截
          （EPERM，sock 在可写区内仍被拒）→ finalize receipt 可信**；
          caveat：证据来自 --listen unix:// 替代进程，未在真实 daemon
          control sock 交叉验证（本机 daemon 子系统装不了）

launchSpec(contract, paths) → {argv[], settingsPath?, cwd, env_names}
  纯数据，不执行。prompt 从文件 bytes 读、单 argv 传入（沿用现行规则）。

normalizeTerminal(runtime, raw) → 候选终态
  claude：先对 result JSON 做 21-key 全集校验（以 allowlist 版本的
          实测 key 集为准）——未知 key fail-closed，不静默丢弃；
          通过后投影 {subtype, is_error, terminal_reason,
          permission_denials}；任一字段缺失 fail-closed。
  codex：事件源 = **turn/started · turn/completed**（turn 计数）+ goal
          status 事件（S2/S4 实测的真实通知 method，非猜测正则）。
          goal status=complete 事件 → 既有候选形状
          {status:"ready_for_postflight", remaining_work:false}
          （workflow.mjs 候选态检查零改动）；
          status=blocked 事件 → 不产候选，走终局报告路径（§3 D5）；
          paused/usage_limited/budget_limited → 按 §4 六态表终局报告。

resumeSpec(runtime, attempt, diagnostics) → {argv[]|rpcOps[]}
  纯数据：claude 出 --resume argv **并强制复用 launchSpec 的
  --settings**（hook 配置随续跑存续，S3 实测不带 --settings 则 hook 静默失效）；
  codex 出「set active + readback 验证 + 注入消息 **+ turn/start**」的 RPC 序列
  （**【v2 实测】S4：inject 本身不驱动执行、只追加进模型可见历史；若 goal 已
  不再自动续轮（idle/complete/budgetLimited），必须配显式 turn/start 才能让注入
  内容被读到。inject method = `thread/inject_items`（下划线），
  items = {type:'message', role:'user', content:[{type:'input_text', text}]}**）。

goalRpc(op, params) → envelope          （codex 专属，controller 独占声明）
  短命 client：连 daemon sock → initialize → 单请求 → 读响应 → 退出。
  暴露 thread.start / **turn.start** / goal.set / goal.get / goal.clear 五个 op
  （turn.start 起首轮——S2 实测 goal set 本身不驱动执行）。
  goal.set 之后调用方比对 **set 返回的实际 status**（S2b 实测 set 响应自身即
  如实返回被拒 status，不必额外 goal.get；仍须比对不假定请求即生效）。
  每次调用的原始 envelope 落盘 controller state（证据留痕）。
  ⚠️ 「controller 独占」是信任模型声明。**【v2 实测】S6：执行器 sandbox 对 sock
  的 connect() 被 seatbelt syscall 层拦截（EPERM）→ finalize receipt 定级可信**
  （caveat：替代进程证据、未在真实 daemon sock 交叉验证）。
```

信任模型：`goalRpc` 只有主会话调用，其 envelope 是 finalize receipt / readback 的唯一合法来源（强度见上）；执行器输出不得反序列化为任何 controller 证据。

### Stop hook（Claude 侧）

- **生成**：launch 前由控制器从 contract 的 postflight command entries 逐条取 argv/cwd 生成脚本——不解释、不改写、零 schema 改动。落 controller state 目录，settings 对其 **Edit** deny 写入（**【v2 实测 S5】deny 对简单 Bash 重定向也有效、方向性反证 KR3，比原「观测性防线」定性强；但精确上限（语义级 vs 字面）INCONCLUSIVE 待补测，仍不宣称完全物理保证**）。
- **hook 执行器是新增组件**（四源审核收口）：现行代码没有 postflight 执行器——`captureCommand` 是 preflight 快照执行器（execFile、非零退出即 `COMMAND_FAILED` 整体抛错、输出哈希的**不变性**语义），与 hook 无复用关系。hook 执行器语义为**达标判定**：逐条跑、逐条记 exit code、多条红**收集不抛**、产出红项清单。
- **判定**：全绿 → 放行停机（候选=达标）；有红且未超预算 → block，红项 id + 安全摘要作为 reason 馈回续轮；超 turn/时间预算（hook 在 state 文件计数）→ 放行停机（候选=未达，如实标注）。**【v2 实测 S3】生效的 block 协议 = hook 输出 JSON decision `{"decision":"block","reason":…}`（exit 0），非 exit code 2。**
- **【v2 实测 S3】hook reason 与 objective 冲突风险（重要）**：hook 的 reason 是「建议」不是「强制」——若它与 objective 语义冲突，模型会遵从 objective 罢工 → 静默 block 到 max_turns 死循环（实测 8 轮全 block）。故控制器生成的 hook reason 措辞必须与 objective 兼容（只说「未达标、请补 X」，不与任务目标矛盾）；且 max_turns 耗尽须走「候选=未达」终局，不能无限 block。
- **运行留痕**：hook 每次执行写一条 state 记录（时间戳 + 结果摘要）；控制器 postflight 校验「hook 运行次数 ≥ attempt 轮数」——把 hook 静默缺席（如 resume 未继承 settings、hook 被旁路移除）变成可验证的红。
- **定位声明**：hook 是续轮驱动器不是验收，其结论不进任何 controller 证据通道——hook 全绿仍可能被控制器 postflight 推翻（如越权 mutation 仅 baseline compare 可见）。
- **env**：hook 命令需要的 env 由脚本从控制器指定的 env 文件加载；这是生成脚本的内部行为，不在「contract argv 禁 shell 字符串」管辖内。

### Codex auth-copy（真实 turn 认证，v2 实测新增）

【v2 实测 Task 4/5】app-server 跑真实 turn 需要认证——隔离 CODEX_HOME 默认无 auth，`turn/start` 会反复 401。launch.mjs 的 codex 侧 auth 处理须遵**安全 auth-copy 模式**（经 Task 4/5 两轮凭证卫生打磨确立）：

- **只读复制**生产 `~/.codex/auth.json`（OAuth token）到隔离 CODEX_HOME；**不碰** `goals_1.sqlite`/`config.toml`/其余生产状态（隔离铁律保护「状态不串」，auth 是认证不是状态）。
- **CODEX_HOME 与 executor cwd 用两个独立 mkdtemp**（不共享可猜测父目录）——否则 workspace-write sandbox 只限写不限读，执行体运行时可 `../codex-home/auth.json` 读到凭证（S4 review 抓出的读取邻近性隐患）。
- **信号安全清理**：清理逻辑抽成幂等 `cleanup()`，`finally` 与 `process.on('SIGTERM'/'SIGINT', cleanup)` 共用——Node 的 `finally` 不在 SIGTERM/SIGKILL 时执行，只靠 `finally` 会在进程被外部 kill 时残留生产凭证副本（Task 5 review 抓出）。
- **凭证绝不进 git、绝不进 fixture/日志**；用后立即清理。

## 6. 外环、attempt 与错误处理

- 一次逻辑 run = 1 首发 + ≤2 续跑；attempt 序号入 controller state（O_EXCL 原子写、单调递增，崩溃后按最大序号恢复），绑定 runBinding。**全程唯一 baseline**：续跑不重新 capture，snapshot verify 永远对照首次 capture。
- **重入语义**：每个 attempt 是状态机的完整一次重入（同 runBinding）；红项「可续/不可续」分类由控制器基于自有原始 verifier 结果判定，不解析 evidence reasons 字符串；通道结构与 `nextAction` 不改。
- 红项分类：

| postflight 红项 | 处置 |
|---|---|
| 未达标类（测试红、产物缺、命令结果不符） | 可续：diagnostic 馈入续跑 |
| 边界违规类（CONTEXT_STATE_CHANGED、GIT_* 越权、未授权 mutation、permission denial 非空） | 不可续，立即终局——执行器已离约 |
| attempt 超限 / 轮询超 deadline | 终局，按 diagnostic 报告差异与下一步 |

- 错误矩阵（全部 fail-closed）：assertLaunchable 任一红 → 不 launch；**daemon 中途死** → abort + 报告，**abort 路径强制跑 snapshot verify 并报告已发生的 mutation**（执行器可能已改仓，「中止」不得被读成「无改动」），残留 goal 由下次 launch 前的残留检查 clear（daemon 已死时 RPC 无对端，clear 必须推迟到 daemon 可达之后）；**controller 死而 daemon 活** → 租约到期**不**触发任何 clear（daemon 不知道租约存在，没有 watchdog；本条曾写成「TTL 到期 daemon 侧自动 clear goal」，实现里没有对应物，2026-08-06 终审改为如实描述）。现状是：租约只用于阻止下一次并发 launch，过期租约同样拦（reason 指向先跑 `close`），因此不会出现「同一 target root 上两个执行器」；孤儿 daemon 本身依赖 app-server 走 stdio、父进程死后 stdin EOF 自退，**本轮未实测、代码不依赖**。残留 goal 的实际清理路径是操作员跑 `close`（goalClear + 删 codexHome）；normalizeTerminal 未知形状/未知 key → 拒绝；goalRpc envelope 缺失/畸形/readback 不等于目标态 → 对应证据 false；hook 脚本运行时缺失 → 视为 launch 环境被破坏，终局。

## 7. 对既有资产的改动清单

| 资产 | 改动 |
|---|---|
| `references/adapters/claude.md` | 重写为 Stop hook 姿态；删 `/goal` 内联假设；补 4000 字符事实、hooks 依赖、21-key 校验 + 4 字段投影、`terminal_reason:"completed"` 的实测锚定与漂移警告。⚠️ 同步 `tests/static.test.mjs` 术语闸：必含 12 术语（含 `/goal`——保留为「已评估弃用」的记名）与 `doesNotMatch(create_goal|get_goal|update_goal)` 反向断言；`--disallowedTools` 保留（仍是权限注入表面之一） |
| `references/adapters/codex.md` | 重写为 app-server 编排姿态（含条件 CASE 写入语义、readback 强制、六态处置表、租约）；模型侧 `create_goal` 明令禁用；「执行器自 finalize」列为反例；附录记录 exec 回退路径（含状态机降级开关）与升级/自造字段声明。同步 static 测试术语闸 |
| `SKILL.md`（协议正文） | Postflight 节改绑：`update_goal` receipt → `thread/goal/set` receipt、`get_goal` readback → `thread/goal/get` readback；「不调用真实 runtime 工具」语句限定为「文档与测试」，与 launch.mjs 的真实启动豁口不冲突的措辞 |
| `references/run-contract.md` | :92 附近同步通道名（update_goal/get_goal → thread/goal/set|get） |
| `scripts/lib/workflow.mjs` | 字面量改绑共 4 处：判定 2（:111、:123）+ reason 文本 2（:112、:123 尾）；exec 回退降级开关**本轮不实现**（§3 D3 v2 更新已降为未来 alpha 协议漂移预留；2026-08-06 用户裁决确认排除）；候选态检查与通道结构不动 |
| `tests/workflow.test.mjs` | 同步 4-6 处字面量断言（降级开关不实现，无分支测试） |
| `scripts/launch.mjs`、`scripts/lib/adapters/*` | 新增（§5） |
| controller state 目录 | **新增承重组件**，规格：位置 `~/.local/state/goal-condition/controllers/<name>/<contract-hash>/`（沿用既有 LDL run 布局）；内容含 hook 脚本、env 文件指针、attempt 序号文件、hook 运行记录、goalRpc envelopes、租约文件；权限 0700，hook 脚本 0500 |
| `manifest`/安装闭包 | 四处同步：`installer.mjs` REQUIRED_CORE_FILES（:19-32，精确集合相等校验 :465-470）、`install.test.mjs` 的 12 文件 fixture、README release member 列表（static.test.mjs:127-135 守护）、目录闭包自动处理（writeRelease 逐段 mkdir，adapters/ 子目录无需额外白名单）。⚠️ 改 REQUIRED_CORE_FILES 后所有旧 release 的 verify 立刻红——**发布顺序**：先完成 F6 信任链 re-pin，再发含新文件的 release |
| `tests/` 其他 | adapter 纯函数测试（fixture 用实测 envelope）；fault injection 五类：伪造 receipt（错 operation 字面量）、cross-binding、hook 篡改探针（**必含 Bash 旁路**）、attempt 超限、readback 不等于目标态 |

## 8. Spike 清单（实现前必过）

Codex 侧：S1b 或 S2 失败 → 回退 exec 单发（含 §3 D3 的状态机降级开关，属已计划行为变更，不重开设计）。Claude 侧：S3 或 S5 失败 → 回退裸 `-p` 单发 + 外环（放弃会话内续轮，保留 resume 外环）。

| # | 验证什么 | 判定 |
|---|---|---|
| S1a | `thread/goal/set` 外部设 `complete`（finalize 方向） | 外部 complete 被接受且 readback 一致 |
| S1b | **非 active → active 拉回**（外环真正依赖的方向；条件 CASE 有闸的那半）：从 `budget_limited`/`complete` set active + readback 实证状态真的变了；含「同请求抬 tokenBudget」变体 | readback 与目标态一致；被吞时 RPC 表象与真实状态的差异被记录 |
| S2 | app-server 线程 idle 续轮在无人值守下真的驱动 | goal active + idle → 观察到自动新 turn |
| S3 | Stop hook 在 `-p` 下的 block/allow 确切协议（JSON decision vs exit code 2），**含 --resume 路径下 hook 是否随 --settings 存续** | hook block 后会话真的续轮且 reason 送达；resume 轮 hook 仍触发 |
| S4 | 向既有 thread 注入续跑消息的 RPC 姿态（`thread/inject` 已确认在 RPC 表面） | 红项 diagnostic 进线程且触发工作 |
| S5 | `--settings` 的 hook + deny 组合在 `-p` 下的**真实防护面**：Write/Edit 工具层拒绝 + **Bash 旁路探针**（`bash -c '... > hook'` 类改写） | Write/Edit 层被拒；Bash 旁路结果如实记录——挡不住即在 spec/adapter 声明 hook 保护为观测性防线（本设计已按此假设写就，S5 结果只影响措辞强度） |
| S6 | **sock 访问壁垒**：codex 执行器在 `--sandbox workspace-write` 下能否 connect 到 `~/.codex` 的 daemon sock | 连不上 → finalize receipt 维持可信；连得上 → receipt 降 audit_only 并更新 §5 信任声明 |

### spike 实测结果（2026-08-06，7 spike 全部完成）

双流水线并行执行（Codex 侧 S1a/S1b/S2/S2b/S4/S6 + Claude 侧 S3/S5），每个 spike 经 implementer→review→fix loop。完整决策矩阵、证据锚点与 11 项折回清单见 `docs/superpowers/spikes/2026-08-06-goal-runtime-adapters-v2-results.md`。

**路径判决**：
- **Codex app-server 全量对接：成立**。生死闸 S2b 三坐实点全真（超预算→budgetLimited→不抬预算被拒→抬预算恢复到 active）；S1b/S2 未 FAIL，**不触发 §3 D3 的 exec 回退**。
- **Claude Stop hook 续轮：成立**。S3 PASS（JSON decision block 协议、单次 -p 内「未达标→block→续轮→达标→停」闭环、resume 继承 hook）；未 FAIL，**不触发裸 -p 回退**。

**改写/收窄本 spec 若干处的关键实测**（完整 11 项见 results.md）：
- 起首轮 = `turn/start`（goal set 不自动执行）；inject = `thread/inject_items`（下划线），items = `{type:message,role,content:[{type:input_text,text}]}`。
- **S2b 坐实 §4 并收窄**：set 响应**自身**即如实返回被拒 status → §4「set 后必须 readback」改「必须读 set 返回的实际 status」。
- goal 必须挂**非 ephemeral** thread；goal_id RPC 层不可得 → §3 D5 finalize 归因改 `updatedAt`+`threadId`+序列号（非 goal_id，且 updatedAt 秒级需序列号兜底）。
- **S4 因果链收窄**：inject 不独立驱动执行（PASS 是自动续轮的在途 turn 读到）→ resumeSpec 在 goal 不再自动续轮时必配显式 `turn/start`。
- **S3 死循环风险**：hook reason 与 objective 语义冲突时模型罢工→静默 block 到 max_turns → §5 需规范 hook reason（不与 objective 冲突）+ max_turns 耗尽处理；resume 必带 `--settings`（坐实 KR12）。
- **S5 方向性反证四源审核 KR3**：deny 对简单 Bash 重定向**也有效**（`permission_denials` 有 tool_name:Bash 实录）→ §5/§8 hook 保护定性从「观测性防线、非物理」改「比 KR3 强、对简单 Bash 有效」；精确机制（语义级路径解析 vs 字面匹配）INCONCLUSIVE，runC/runD 12 次全撞 API 529、待稳定期补测；§7 hook 篡改探针测试必含 Bash 直接重定向用例。
- **S6 finalize receipt 定级为可信**：sandbox seatbelt syscall 层挡住执行器 connect sock（sock 在沙箱可写区 /tmp 内仍 EPERM）；**caveat**：证据来自 `--listen unix://` 替代进程（本机 daemon 子系统装不了），未在真实 daemon control sock 交叉验证。
- **auth-copy 安全模式**（Task 4/5 确立，新增 §11 类约束）：真实 turn 需认证 → 隔离 CODEX_HOME 只读复制生产 `auth.json`，独立 mkdtemp（codexHome 与 work 不共父目录）+ finally + SIGTERM/SIGINT 信号兜底清理。实现阶段 launch.mjs 的 auth 处理须遵此模式。

回退路径（§3 D3 exec 单发 / 裸 -p）本轮**均未触发**——两条路径实测成立。上表 S1b/S2/S3/S5 判定按此更新。

## 9. 测试策略

- adapter 纯函数入 core 测试套；fixture 使用实测真实 envelope（Claude 21-key result；Codex envelope 由 spike 抓取）。
- 穷尽变异纪律：逐条 revert 生产判定确认对应测试变红。
- 既有 119 测试保持全绿；workflow 字面量改绑与降级开关处的测试同步修改视为行为变更，须在 commit message 声明。
- static.test.mjs 术语闸随两份 adapter 重写同步（§7）。

## 10. 范围外与挂账

- validator 机械化（no-shell 闸、git 许可 enum、context∩mutation lint）、command entry `capture:"none"`、安装信任链 re-pin 流程（F3/F6 体系债）——单开一轮；**其中 F6 re-pin 因 §7 发布顺序依赖，须在本轮 release 发布前完成**。
- P0 批次 contract 重编译（F1/F2 必死缺陷）、2026-08-05 run 的 finalize receipt 定性复查——执行任务，spec 落盘后即可做，不依赖本轮实现。
- app-server 长驻多 goal 并行编排、事件驱动通知消费——本轮只做轮询 + 单 goal，需要时再扩。
- `pressure-evidence.json` 所测指令文本与新协议的漂移（重跑 5 场景 ×2 变体的成本决策）——挂账。
- advisory 备忘（实现计划时逐条过）：hook 命令副作用可能落 target root 触发误判「不可续终局」（hook 命令集限无写副作用子集或把产物路径纳入 allowed_mutations 并 preview 显式列出）；postflight「红」的判据（command entry 无 expected 字段，红=非零退出）在 adapter 文档钉死；`deferGoalContinuation`（fork 场景,本轮不触发）。
