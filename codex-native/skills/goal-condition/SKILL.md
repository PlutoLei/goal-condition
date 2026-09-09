---
name: goal-condition
description: Shape a sustained Codex task into a clear goal, scope, and verifiable completion criteria, then use native Goal mode when execution is requested. Also use to review progress or migrate a legacy goal; planning alone does not start execution.
---

# Goal planning and verification for Codex

Native `/goal` is the only execution path for new Codex goals. This skill defines the work and its evidence; the host owns execution, pause/resume, budgets, and goal status. It does not operate a second controller or certify a runtime.

## Route by the user's request

- **Research, plan, or rewrite a skill:** deliver the requested analysis or changes. Reading or editing this skill is not a request to run its workflow. Do not create a goal for planning alone.
- **Execute a sustained goal:** reuse the user's stated outcome, scope, approvals, and acceptance criteria. Briefly state the actionable goal and start through the host's native goal capability when explicitly requested. An approved instruction to execute an already designed goal counts; do not ask for a second confirmation of the same work.
- **Already in Goal mode:** read and continue the existing goal. Do not create a duplicate, another task, an agent, or a scheduler to keep it alive.
- **Legacy session:** read [legacy-migration.md](references/legacy-migration.md). Never consume an old admission or launch a new legacy Attempt as a fallback.

When the native interface is unavailable, provide the goal text for the user to enter with `/goal` and state that it has not started. Do not claim that printing a slash command activates it. Copying to the clipboard is optional and only done on request.

## Define only what changes decisions

Use an observable outcome, relevant scope/non-goals, completion criteria with evidence, and material recovery or permission boundaries. Add an execution plan when dependencies justify it; implementation choices remain flexible inside the authorized scope. Several necessary deliverables may serve one outcome. Ask the user to choose only when the proposed outcomes conflict or cannot form one coherent task.

Keep a small goal in the conversation. For long work, reuse an existing task record or create a lightweight record when recovery needs it. No mandatory JSON, registration, directory snapshot, authorization hash, fixed text limit, or checkpoint file.

Record resource limits only when supplied by the user, with their units. A native token budget is not a currency or wall-clock limit. Omit unspecified limits rather than inventing defaults or treating absence as permission to spend. See [native-goal.md](references/native-goal.md) when using host tools.

## Execute within real authority

Use the host's actual tools, sandbox, approvals, and current project rules. This skill grants no extra access and imposes no blanket network ban. A paid run, publication, deployment, credential access, or other external effect needs authorization appropriate to that action; reuse authorization already given for that scope. Prepare a concrete reviewable result before asking for a missing decision.

No project enrollment is needed. Worktrees are optional isolation tools, not admission identities. Use the current workspace unless the task or concurrent edits justify isolation. An unrelated environment-file symlink does not require moving the project; inspect the resolution before accessing or changing an actual target. Preserve existing edits and avoid concurrent writes to the same files.

Project research, frozen-protocol, publication, and independent-review requirements still apply. If a project explicitly requires legacy certification, explain the incompatibility and continue independent authorized work; do not run the legacy controller for a new goal or silently waive the project's gate.

## Verify and recover

Bind each material completion claim to observed tests, measurements, or review evidence. A planned test is not a passed test. Mock evidence proves only the mocked contract. Distinguish engineering checks, real service/compute results, and scientific acceptance. [verification.md](references/verification.md) covers evidence records and the optional local evidence checker.

For a recoverable failure, diagnose and fix within scope, then rerun affected checks. Repeated attempts without new evidence call for a different diagnosis, not weakened criteria. Do not drop required deliverables, relabel unrun tests as not applicable, or mark a goal complete to stop an inconvenient run.

Send concise updates on findings and the next unresolved point. Answer status questions and continue unless the user stops or replaces the work. Respect native pauses and cancellations; never restart via another process or automation. Mark blocked only under the host's actual rules, not after an invented retry count.

## Finish

Check all required outcomes and remaining work before requesting native completion. Report artifacts, actual verification, and material limitations. Commits and publication are required only when requested or required by the project. Never label native completion `Certified Complete` or infer legacy certification from a green test.

Use hashes for evidence integrity when useful, not as an ordinary permission ritual. Verification summaries describe evidence; they do not duplicate native lifecycle state.
