# Codex continuation-lineage attribution v3

Status: approved fallback design; implementation candidate only

## Context

Codex goal execution may create native continuation turns after one controller `turn/start` request.
The strict fresh-thread `0 -> 1` fence correctly proves the first persisted input, but it cannot
distinguish a product-owned continuation chain from an externally injected second user turn. A live
Task 2 canary on Codex CLI 0.148 observed one controller launch and three persisted native turns, so
the v2 single-turn receipt rejected the run as `CONTROL_PLANE_BYPASS`.

## Decision

LaunchReceipt v2 remains valid for an attributable single persisted turn. A new LaunchReceipt v3 uses
the same closed field set and changes only these semantics:

- `turn_id` remains the root persisted turn;
- `turn_input_sha256` remains the exact controller-bound root input hash;
- `authorized_turn_ids` is the ordered, unique, non-empty complete native continuation chain, with
  `authorized_turn_ids[0] === turn_id`;
- the controller must have observed an empty initial turn set and issued exactly one `turn/start`;
- the first persisted turn contains exactly one well-formed user text message whose hash equals
  `turn_input_sha256`;
- every later persisted turn contains zero user messages and is classified as a native continuation;
- the observed `turn/started` notification count for the Attempt equals the persisted chain length.

Receipt v3 is created only when the chain contains more than one turn. Existing v2 receipts and stored
GoalSessions remain readable; the GoalSession schema stays at version 2 and admits receipt versions 2
and 3 without rewriting state.

Verification, reconciliation, rollout-canary certification, and both finalize turn fences compare the
exact ordered chain. A later user message, malformed user-message shape, duplicate, missing, reordered,
or newly appended turn is never inferred to be a continuation and remains a control-plane bypass or
an attribution mismatch.

## Trust boundary

The controller owns the private stdio app-server connection and the only supported `turn/start` call.
Direct process or pipe tampering remains outside the application-layer threat model, as before. The
executor cannot write controller state. Executor prose, tool output, and repository bytes never become
lineage evidence.

## Rollout

This change is limited to controller/adapter code, protocol documentation, schemas, and tests. It does
not activate a generation, migrate a registry, contact AutoDL, access credentials, mutate a provider,
spend money, release, or authorize formal M1. A new generation requires a separate exact approval and
must pass a live local canary before Task 2 can be certified.
