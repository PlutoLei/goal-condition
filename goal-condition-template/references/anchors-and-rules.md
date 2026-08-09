# 项目 profile 模板

此文件是安装时注入的 data-free profile 模板。公开核心只保留“去哪里取得核验命令与规则”的引用，不保存项目名、资产标识、绝对工作站路径、实测计数或会随代码变化的结果。编译 contract 时读取所引用的稳定来源，为每个进入 `context_sources` 的文件计算 bytes SHA-256，并在现场验证来源仍有效。

## 验收与上下文来源

| 适用范围 | 核验命令来源 | 判断与产物来源 |
|---|---|---|
| `<workload-family>` | `<stable command registry or script reference>` | `<stable specification or artifact reference>` |

## Constraint 与 mechanism 来源

| 适用范围 | Constraint 来源 | Physical mechanism 与核验命令来源 | Audit-only 观察来源 |
|---|---|---|---|
| `<workload-family>` | `<stable policy reference>` | `<sandbox, deny rule, proxy, hook, or verifier reference>` | `<independent audit reference>` |

## Allowed mutations 与边界来源

| 适用范围 | 文件与 Git 范围来源 | 外部动作来源 | Preflight/Postflight 来源 |
|---|---|---|---|
| `<workload-family>` | `<stable ownership or delivery policy reference>` | `<stable external-operation policy reference>` | `<stable verifier source reference>` |

来源缺失、不可重读、处于临时路径、hash 无法绑定或彼此冲突时停止编译并请求补充。不要在本模板抄录来源内容；不要把现场输出写回模板。
