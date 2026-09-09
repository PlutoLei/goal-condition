---
name: boundary-design
description: Define an observable goal, relevant boundaries, and verifiable exit criteria before sustained work or a design decision. Produces a portable goal brief without starting a runtime or requiring a legacy contract.
---

# Boundary design

Turn a task into an outcome, a few meaningful boundaries, and observable exit criteria. This skill plans; native Goal mode executes when the user requests it. A fully specified task may need only a short check rather than a new design interview.

For each proposed boundary ask:

1. What concrete failure and cost does it prevent? Reserve hard constraints for significant failures.
2. Can the agent infer it from the environment? Avoid repeating discoverable implementation details.
3. What is its smallest valid scope: this task, project, or host?
4. Is it enforced by a real interface or sandbox, or only checked afterwards? Name the mechanism and evidence before claiming physical enforcement.

Use the parts that matter:

```text
Outcome: one coherent user-visible result
Scope and non-goals: affected work and exclusions
Completion: criterion -> evidence/check -> relevant limitations
Judgment: observable tradeoffs, without a predetermined conclusion
Authority: authorized files, Git actions, and external effects; missing approvals
Recovery: material failures and how work can resume safely
Resources: only user-supplied limits, with units
```

Necessary deliverables can serve one goal. Ask about genuinely conflicting outcomes; do not split a coherent task just because it touches multiple modules or repositories. Explain meaningful dependencies without prescribing every implementation action.

An empty hard-boundary list is valid. No mandatory hash, registration, directory snapshot, or JSON schema. Use content hashes when evidence reproducibility needs them. Separate proposed checks from existing verifiers and synthetic evidence from observed results.

When execution is requested, pass the brief to the Codex `goal-condition` skill/native Goal path. When only a plan is requested, deliver the plan and stop. Do not start a runtime, alter permissions, copy the clipboard, or create a second goal merely because this skill was invoked.
