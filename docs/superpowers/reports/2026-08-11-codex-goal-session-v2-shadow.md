# Codex GoalSession v2 Foundation + Shadow 验收报告

日期：2026-08-11

范围：仅 Codex 侧契约与控制面

阶段：Plan 1 — Foundation + Shadow

## 1. 结论

Plan 1 已建立独立的 Codex GoalSession v2 控制面基础：Goal、Authority、Design Revision、Attempt 与 Evidence 拥有不同生命周期和独立哈希；Authority 内的结构化单调修订可由 controller 判定，扩大授权、弱化 Condition 或改变 Goal 会 fail closed 到再授权或 successor；v1 contract 仅作为 Attempt 的不可变投影。

本阶段仍是 **shadow only**。controller 只进行编译、确认记录、修订判定、Attempt 投影、Evidence 评估、legacy replay 与审计导出，不存在 live launch/resume/finalize/close 命令，也没有启动或续跑任何真实 Codex task。当前 live 路径仍执行 v1 的 Validate → Preview → Confirm(hash) 语义。

## 2. 根因与 RED → GREEN 压力证据

真实 RED 不是“确认按钮太多”，而是 v1 把稳定 Goal、低频 Authority、动态 Boundary/Condition 和一次性 Attempt 聚合进同一 canonical hash。旧版 Skill 在 Goal、Authority、风险预算与交付物均未变化、只有 context hash 和等价 verifier 变化时，仍要求停止 run、重建完整 canonical contract，并重新确认新 hash。这证明重复确认来自聚合边界，而不是文案问题。

最终 Skill 与 Codex reference 的完整字节分别由 SHA-256 绑定到压力证据。fresh-context GREEN 结果如下：

| 场景 | GREEN 样本 | 结果 |
|---|---:|---|
| S1：连续出现 verifier、context 与 active boundary 调整 | 5/5 | 全部选择 C；区分 typed revision 与 reauthorization；全部说明 Plan 1 不能把 revision 应用于 live run |
| S2：八个绿灯后 reviewer 报告 blocker | 1/1 | 选择 B；降为 Candidate、失效依赖 Evidence，拒绝团队或 reviewer 自证 Certified |
| S3：把 Grill 放进每次 runtime | 1/1 | 选择 B；Grill 只用于设计评审，runtime 只检查 blocking CompilationGap |

压力样本是观察性证据，不替代确定性的领域、状态机、mutation 与故障注入测试。RED 样本被保留，没有用 GREEN 覆盖历史失败。

## 3. 实现结果

| 设计范围 | Plan 1 落地 |
|---|---|
| §4 核心模型与不变量 | 独立 Goal、Authority、Authorization、Design、Attempt 哈希；Goal 与 root baseline 不可洗白 |
| §5 Authority / Design / Condition / Evidence | closed-world 数据模型；Condition 无可变 satisfied；Evidence 绑定 verifier 版本、Attempt 与输入哈希 |
| §6 双层状态机 | GoalSession 与 Attempt 使用封闭状态转换；无 Receipt、无当前 Evidence 或跨 binding 跳转均拒绝 |
| §7 Revision Policy | 12 类 typed operation；controller 结构证明单调性，不接受 executor 的 `monotonic=true` 自报 |
| §8 Compiler 与确认 | 确定性 compiler、blocking CompilationGap、完整 preview、Authorization Receipt；没有 runtime Grill |
| §9 Attempt 投影 | 生成有效 v1 manifest、hash-bound Context Package 与逐 Condition Projection Proof；native objective 保持短 Goal |
| §10 Evidence 局部失效 | context、verifier、artifact、runtime 与 boundary 依赖发生变化时只失效受影响 Evidence |
| §11.3–11.5 Codex-only / 持久化 / 原子提交 | 独立 Node 24.15+ 包；SQLite/WAL、CAS blob、CAS revision、event hash chain 与权限隔离 |
| §14 Shadow | legacy 只读 replay 与分类完成；Opt-in、Default、Legacy Freeze 未实现 |
| §15 验证 | unit、500 条确定性随机事件序列、mutation check、真实 SIGKILL crash injection 与压力证据 |

controller CLI 只暴露 `init`、`confirm`、`revise`、`project`、`evaluate`、`shadow`、`status`、`export`。源代码扫描确认没有引用 `GoalRpcClient` 或任何 `runCodexLaunch`、`runCodexResume`、`runCodexFinalize`、`runCodexClose`。

## 4. Shadow 分类结果

| legacy 变化 | shadow decision |
|---|---|
| 已标注且在 Authority 内的 typed Design Revision | `auto_apply` proposal |
| target root 扩大 | `EXPAND_AUTHORITY` → `reauthorize` |
| Condition 弱化 | `WEAKEN_CONDITION` → `reauthorize` |
| objective 语义改变 | `CHANGE_GOAL` → `successor_required` |
| 未识别差异 | `UNCLASSIFIED` → `reject` |

shadow 输出固定包含 `mode="shadow"` 与 `live_execution=false`。CLI 测试对 legacy state 做执行前后 SHA-256 对比，证明 replay 没有修改旧状态。

## 5. False-green 与故障门禁

- 500 条确定性随机事件序列持续保持 Goal、root baseline 与 authorization 不变量。
- reviewer 文字和 executor all-green 只能形成候选输入，不能生成 controller-owned Evidence。
- 只要存在 control-plane bypass，最高只能到 Verified，不能到 Certified。
- verifier 版本、context、artifact 或 runtime 输入漂移会使对应 Evidence 失效。
- SQLite store 在 blob 发布后、数据库提交前接受真实 SIGKILL；恢复后不存在 false commit，孤儿 blob 可被安全容忍。
- store 使用 0700 state root，数据库、MAC key 与敏感元数据使用 0600；并发写通过 revision compare-and-swap 拒绝 stale writer。

## 6. 发布闭包与兼容边界

immutable release 闭包新增 13 个 controller 生产文件：`package.json`、2 个 schema 与 10 个 `src` 模块；`tests` 与 pressure evidence 不进入 release。磁盘文件树是独立真相源，防止 `REQUIRED_CORE_FILES` 通过自建清单自证完整。安装测试确认 manifest 对所有 controller 文件记录 mode 与 SHA-256，外部保留的 manifest digest 仍是 verify 的信任根；controller 文件的内容或 mode 被篡改都会报告 drift。

controller 安装后的 `package.json` 保留 `engines.node >=24.15.0`。根包 Node 下限和依赖没有变化。

相对基线提交 `0055e77` 的逐文件比较显示：Claude adapter、共享 v1 schema、run-contract reference、workflow、contract、snapshot、launch 与 validator 字节未变。共享 installer 只做发布闭包扩展；SKILL.md 与 Codex reference 是预期的 Codex shadow 路由文档改动。

## 7. 终验结果

| 检查 | 结果 |
|---|---|
| 根测试套件 | 335/335 PASS |
| Codex controller 测试套件 | 76/76 PASS |
| Skill 长度 | 93 行，低于 200 行上限 |
| Node.js | v24.15.0 |
| `node:sqlite` | 可加载 |
| diff whitespace | clean |
| live Codex task | 未启动、未续跑 |

## 8. Plan 2 仍需验证的事实

Plan 1 不实现设计 §12–13 的 live bypass/recovery，也不进入 §14 的 Opt-in 或 Default。进入 Controlled Execution 前必须用真实运行面验证：

1. Codex sandbox 是否能物理拒绝 executor 读取 controller state；不能时如何显式降级 capability。
2. app-server readback 能否稳定绑定 run、thread、turn、Attempt 与 Context Package。
3. 缺少 task-level lock 时，直接续跑、未受控 turn 与并发 writer 能否完整检测。
4. LaunchIntent、turn/start、Launch Receipt 与崩溃恢复的精确提交顺序，尤其是模糊启动结果不能产生重复 Turn。
5. live workspace 的 symlink、大小写、多 root canonicalization 与外部 mutation 对账。
6. lease、SIGTERM、daemon death、超时与恢复路径在 GoalSession v2 集成后的真实行为。
7. Legacy adoption 的新 Receipt、历史 baseline provenance、回滚与只读导出策略。

这些事实未验证前，能力必须报告为 legacy、DETECTED、UNAVAILABLE、Blocked 或 ReconciliationRequired；不得用 prompt 约束代替，也不得声称动态 revision 已在 live run 生效。
