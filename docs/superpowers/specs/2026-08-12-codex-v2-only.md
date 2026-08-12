# Codex V2-Only Cutover Design

## Status

Approved on 2026-08-12. This design narrows only the Codex side of goal-condition. Claude and the shared run-contract schema keep their existing semantics.

## Problem

The current release uses “v1” for three different concepts:

1. the legacy Codex live lifecycle;
2. the input format accepted when an old Codex task is adopted;
3. the private immutable manifest projected by GoalSession v2 for the proven launcher boundary.

That naming leak is not cosmetic. The Skill still routes legacy Codex tasks to the old lifecycle, rollout modes can leave v1 live, and the controller exposes `shadow` and `adopt` as first-class commands. Changing only the default route would leave executable fallback paths and make a later regression likely.

Deleting every v1-shaped object is also incorrect. Claude still owns the shared v1 contract, while GoalSession v2 intentionally reuses its closed-world validator and launcher as a private attempt ABI. Rewriting that boundary would enlarge the trusted codebase without improving the V2 user contract.

## Decision

Codex has one public and executable protocol: GoalSession v2.

- A new Codex task always enters GoalSession v2.
- A missing, disabled, or incompatible V2 controller fails closed. It never falls back to legacy Codex execution.
- An old Codex contract can only be consumed by the explicit one-way `migrate-v1` import command.
- Migration creates an unconfirmed GoalSession v2 Draft. Legacy confirmation, runtime state, and completion evidence never authorize or certify the V2 Session.
- The private per-Attempt launcher payload is named `AttemptManifest`. It remains validated by the shared closed-world schema and may retain `version: 1` as its data-format version.
- Claude continues to compile and execute the shared v1 run contract without semantic changes.

## Alternatives

| Alternative | Benefit | Cost | Decision |
|---|---|---|---|
| Change only the Skill default | Smallest diff | Leaves legacy execution, shadow, and fallback reachable | Reject |
| V2-only control plane with one-way migration and private AttemptManifest | Removes Codex ambiguity while retaining proven safety boundaries | Requires controller, rollout, docs, tests, and release migration changes | Adopt |
| Rewrite launcher around a new native V2 manifest | Removes the last internal `version: 1` value | Duplicates validator and launcher logic, expands the trusted base, risks false-green regressions | Reject |

## Routing Contract

The router has exactly two runtime branches:

```text
Codex: GoalSession v2 only
Claude: shared run contract
```

For Codex, controller capability and release compatibility are prerequisites. Failure reports a stable V2 controller diagnostic and a concrete installation or migration next step. It must not compile, confirm, preflight, launch, resume, finalize, or close a legacy Codex run.

## V2 Release Gate

Release gating remains because V2-only does not mean every controller build should receive immediate global traffic. The gate becomes V2-native:

```text
disabled -> canary -> enabled
```

- `disabled`: all live Codex execution is blocked.
- `canary`: V2 live execution is allowed only when explicitly selected by the caller.
- `enabled`: V2 is the normal Codex route.

No mode enables V1. A missing state file is `disabled`. Promotion from `canary` to `enabled` still requires a controller-certified canary receipt bound to the installed release digest.

For operational rollback, `canary` and `enabled` may move to `disabled`, and `enabled` may move back to `canary`; these transitions only reduce V2 exposure and never select V1.

Installed legacy rollout state is migrated once and monotonically:

| Previous mode | V2-only mode |
|---|---|
| `shadow` | `disabled` |
| `opt-in` | `canary` |
| `default` | `enabled` |
| `legacy-freeze` | `enabled` |

The migration reader accepts the old closed-world state shape only for conversion. New writes use the new schema version and new mode vocabulary. An invalid or ambiguous old state fails closed.

## Legacy Task Migration

The controller exposes `migrate-v1`, not `adopt`.

1. Validate that the input is a closed-world Codex v1 contract object.
2. Capture or read the migration baseline.
3. Compile Goal, Non-goals, Authority, Design, Conditions, and content-bound Context into a V2 Draft.
4. Store immutable migration provenance.
5. Require the normal V2 authorization preview and confirmation.
6. Launch only a new immutable V2 Attempt.

The migration artifact is input evidence, not an executable contract. There is no legacy resume or legacy completion import. The controller reports that historical state is unverified and does not certify anything before the migration baseline.

## Private Attempt Boundary

`projectAttempt` continues to produce three immutable artifacts:

- `AttemptManifest`: the launcher payload;
- `ContextPackage`: full hash-bound GoalSession context;
- `ProjectionProof`: the total mapping from every active Condition to manifest fields, runtime context, verifier, and Evidence dependencies.

Public code, errors, docs, and tests use `AttemptManifest` terminology. The validator adapter may delegate to the shared run-contract validator, but no Codex routing decision may inspect the manifest format version and select a legacy lifecycle.

The following invariants stay unchanged:

- every active Condition has exactly one projection mapping;
- every projected verifier is closed-world and command-shaped;
- read-only Active Boundary yields no writable file mutations and a read-only Codex sandbox;
- the controller owns preflight, postflight, Evidence, receipts, finalization, and close;
- a Candidate cannot self-certify;
- control-plane turn receipt and persisted input attribution remain exact.

## Controller Surface

Remove the `shadow` command and legacy shadow classifier from the production release. Rename `adopt` to `migrate-v1`. Preserve the remaining V2 commands:

```text
capabilities init preview confirm prepare launch verify revise resume
finalize reconcile close project evaluate status export mode migrate-v1
```

The mode API accepts only `disabled`, `canary`, and `enabled` for new writes. Live commands call the V2 gate and receive no legacy routing result.

## Documentation

The Skill introduction and routing diagram must no longer mention “legacy Codex”. The shared compile/validate/preview/confirm sections are labeled Claude-only. Codex documentation describes the private launcher payload as `AttemptManifest`, while migration documentation may explicitly say “v1 input” because that is the format being retired.

Historical design and plan documents remain historical records. A new ADR supersedes only their Codex rollout and legacy-live sections; it does not rewrite history.

## Compatibility

- Existing GoalSession v2 Sessions and their hashes remain readable.
- Existing enabled/default installations migrate to `enabled` without reopening V1.
- Existing v1 Codex tasks cannot continue live; they require `migrate-v1`.
- Claude and the shared v1 validator remain unchanged.
- The internal launcher ABI remains compatible, minimizing changes to snapshot and runtime code.

## Mechanical Acceptance

The change is complete only when fresh evidence proves:

1. the Skill has no Codex legacy route or fallback wording;
2. `commandNames()` has `migrate-v1` and lacks `adopt` and `shadow`;
3. missing or disabled controller state blocks Codex live execution without invoking the legacy launcher;
4. rollout writes accept only `disabled`, `canary`, and `enabled`;
5. old rollout states migrate deterministically and fail closed on invalid shapes;
6. migration creates a Draft requiring V2 confirmation and cannot import legacy certification;
7. the private manifest remains closed-world and has complete Condition coverage;
8. Claude contract, adapter, workflow, and tests remain behaviorally unchanged;
9. the full root and Codex controller suites pass;
10. the installed release verifies against its external manifest digest;
11. a live installed-skill smoke shows Codex V2 routing and no callable legacy Codex command;
12. the GitHub branch is merged and the installed release corresponds to the merged commit.

## Non-Goals

- Redesigning Claude or the shared run-contract schema.
- Rewriting the proven launcher, snapshot engine, verifier sandbox, or Codex app-server adapter.
- Treating migration as confirmation or historical certification.
- Removing format version numbers that do not represent the legacy Codex lifecycle.
