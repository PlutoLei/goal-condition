# Native Goal integration

Discover the interfaces actually available in the current host. `/goal` is the user-facing command, not a shell executable.

In hosts exposing `create_goal`, `get_goal`, and `update_goal`:

1. Use `get_goal` when there may already be an active goal. Continue it when it matches the task. Do not replace an unfinished goal through another channel.
2. Use `create_goal` only for an explicitly requested goal, including an approved instruction to execute the designed goal. Supply the observable objective. Supply `token_budget` only for an explicit token budget supported by that tool.
3. Keep related implementation, testing, and recovery in the current task. Do not create another task or subagent without its applicable authorization.
4. Use `update_goal` only for the statuses and conditions its current schema permits. Do not use it to emulate pause, resume, edit, or budget controls. Those may be available only to the user through the native UI.
5. A failed or ambiguous create/completion response requires readback before retrying. Do not create duplicate work or declare success without confirmation.

When these interfaces are missing, do not substitute a legacy launcher, `codex exec` loop, heartbeat, or OS scheduler. Provide a ready-to-use objective and state the capability limitation.

An explicit execution request with clear scope needs no additional custom confirmation. Ask only for missing material decisions or authority. User changes to goals, budgets, or external effects must be reflected accurately, with host controls used where available.

Official reference, checked 2026-09-09: [Long-running work](https://learn.chatgpt.com/docs/long-running-work). Recheck current documentation when host behavior is uncertain; this file does not freeze product internals or assume an undocumented evaluator algorithm.
