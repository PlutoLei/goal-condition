# 三条挂账小项（来自各轮 review，均已定位到具体代码）

> **状态：三条均已修复并落测。** 保留本文件是为了记录问题形态与判据来源；
> 下面每条的「要求」是当时提出的修复口径，不是仍待处理的工作。

## 1. NEW-1（低）：位置闸对缺失 targetRoots fail-open，且接线无测试覆盖
`stateDirReasons` 内部两种缺失方向不一致：`targetRoots` 缺失/为 [] 时静默放行（GREEN），
采到了才判（RED）。变异 MUT-A2 把采集层的 targetRoots 传成 [] 后 323 条全绿存活——
现有覆盖只有一条纯函数用例，没有任何用例断言这道闸被正确接到真实 launch 路径的真实采集上。
要求：targetRoots 缺失/为空时 fail-closed（视为无法判定即拒，reason 如实）；
补一条断言「接线正确」的用例（采集层被破坏时必须红）。

## 2. f-1（Minor）：_failPending 把「留痕」排在「settle」前面
留痕（onChildFailure）抛错就 return，后面的 settle 再也不跑 → 崩溃收场而非干净终局报告。
要求：先 settle 所有 pending，再留痕；或把留痕包进 try/catch 保证 settle 必达。

## 3. raiseTokenBudget 字符串静默回落（Nit）
非数字类型（字符串）走 `> 0` 闸时静默回落，CLI 正则拒得住但直接 import 的调用方拒不住。
要求：非 number 类型显式拒绝，不静默回落。
