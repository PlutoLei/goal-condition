import { createHash } from 'node:crypto';

import { canonicalJson, contractHash } from '../../scripts/lib/contract.mjs';
import { singleTurnCandidateText } from '../../scripts/lib/adapters/codex.mjs';
import {
  createLaunchIntent,
  createLaunchReceipt,
  realizeAttempt,
} from './attempt.mjs';
import { transitionAttempt, transitionSession } from './domain.mjs';
import { projectAttempt } from './projector.mjs';
import { reconcileLaunch } from './recovery.mjs';
import { assertRootIdentities, captureRootIdentities } from './values.mjs';

const HASH = /^[0-9a-f]{64}$/;

function executionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function intentWithoutStatus(value) {
  const { status: ignored, ...intent } = value;
  return intent;
}

export function attemptRuntimePrompt(projection) {
  return {
    objective: projection.manifest.objective,
    turn_text: singleTurnCandidateText([
      'Execute this immutable GoalSession Attempt. The Controller, not this executor, certifies completion.',
      `Context Package SHA-256: ${projection.contextPackage.sha256}`,
      projection.contextPackage.bytes,
      `Projection Proof SHA-256: ${projection.projectionProof.sha256}`,
      projection.projectionProof.bytes,
    ].join('\n\n')),
  };
}

export function prepareControlledAttempt({
  store, sessionId, attemptId, workspaceDigest, runId, expiresAt, nonce,
  capabilityReport, controllerReleaseDigest, creationRequest = null,
}) {
  if (capabilityReport?.launchable !== true) {
    throw executionError('CAPABILITY_PREFLIGHT_FAILED', 'required runtime capabilities are not enforced');
  }
  if (typeof workspaceDigest !== 'string' || !HASH.test(workspaceDigest)) {
    throw executionError('WORKSPACE_DIGEST_INVALID', 'workspaceDigest must be lowercase SHA-256');
  }
  const session = store.read(sessionId);
  if (session.attempts.some((attempt) => attempt.attempt_id === attemptId || attempt.run_id === runId)) {
    throw executionError('ATTEMPT_ALREADY_EXISTS', 'attempt id and run id must be unique within a GoalSession');
  }
  const projection = projectAttempt({
    session,
    designRevision: session.design_revisions.at(-1),
    attemptId,
  });
  store.putBlob({ kind: 'context-package', bytes: projection.contextPackage.bytes });
  store.putBlob({ kind: 'projection-proof', bytes: projection.projectionProof.bytes });
  store.putBlob({ kind: 'attempt-manifest', bytes: canonicalJson(projection.manifest) });
  const intent = createLaunchIntent({
    sessionId,
    attemptId,
    designRevisionHash: session.design_revisions.at(-1).design_revision_hash,
    attemptHash: projection.attemptHash,
    contractHash: contractHash(projection.manifest),
    contextPackageHash: projection.contextPackage.sha256,
    projectionProofHash: projection.projectionProof.sha256,
    workspaceDigest,
    controllerReleaseDigest,
    targetRootIdentities: captureRootIdentities(
      session.design_revisions.at(-1).active_boundary.target_roots,
    ),
    runId,
    nonce,
    expiresAt,
    keyId: store.controllerKeyId(),
    signer: (value) => store.controllerMac(value),
  });
  const ownerToken = sha256(canonicalJson({
    session_id: sessionId,
    attempt_id: attemptId,
    run_id: runId,
    nonce,
  }));
  const persisted = store.persistLaunchIntent({
    intent,
    roots: session.design_revisions.at(-1).active_boundary.target_roots,
    ownerToken,
    writable: session.design_revisions.at(-1).active_boundary.actions.includes('write'),
    creationRequest,
  });
  const effectiveIntent = intentWithoutStatus(persisted);
  const recovered = effectiveIntent.run_id !== runId;
  const effectiveOwnerToken = sha256(canonicalJson({
    session_id: effectiveIntent.session_id,
    attempt_id: effectiveIntent.attempt_id,
    run_id: effectiveIntent.run_id,
    nonce: effectiveIntent.nonce,
  }));
  return {
    session_id: effectiveIntent.session_id,
    attempt_id: effectiveIntent.attempt_id,
    run_id: effectiveIntent.run_id,
    intent: effectiveIntent,
    owner_token: effectiveOwnerToken,
    intent_status: persisted.status,
    recovered,
    projection: recovered ? null : projection,
    runtime_prompt: recovered ? null : attemptRuntimePrompt(projection),
  };
}

async function reconcileAmbiguous({ store, prepared, readback }) {
  let native = { available: false };
  try {
    native = await readback({ prepared });
  } catch {
    native = { available: false };
  }
  const reconciliation = reconcileLaunch({
    intent: prepared.intent,
    receipt: null,
    native,
  });
  const session = store.read(prepared.session_id);
  const next = transitionSession(session, { type: 'RECONCILIATION_REQUIRED' });
  const committed = store.compareAndCommit({
    sessionId: session.session_id,
    expectedRevision: session.revision,
    eventType: reconciliation.disposition === 'control_plane_bypass'
      ? 'CONTROL_PLANE_BYPASS_DETECTED'
      : 'LAUNCH_RESULT_AMBIGUOUS',
    nextState: next,
    blobs: [],
  });
  store.updateLaunchIntentStatus({ runId: prepared.run_id, status: 'ambiguous' });
  return { ...reconciliation, session: committed };
}

export async function launchControlledAttempt({
  store, prepared, launch, readback, now, controllerReleaseDigest,
}) {
  if (typeof controllerReleaseDigest !== 'string' || !HASH.test(controllerReleaseDigest)
    || prepared.intent.controller_release_digest !== controllerReleaseDigest) {
    throw executionError(
      'CONTROLLER_RELEASE_CHANGED',
      'the controller release changed after this LaunchIntent was prepared',
    );
  }
  const storedRecord = store.readLaunchIntent(prepared.run_id);
  if (storedRecord.status !== 'pending') {
    throw executionError('LAUNCH_INTENT_NOT_PENDING', 'a claimed launch intent must never be replayed');
  }
  const stored = intentWithoutStatus(storedRecord);
  if (canonicalJson(stored) !== canonicalJson(prepared.intent)) {
    throw executionError('LAUNCH_INTENT_MISMATCH', 'prepared intent does not match durable state');
  }
  assertRootIdentities(prepared.intent.target_root_identities);
  const ready = store.read(prepared.session_id);
  const dispatching = transitionSession(ready, { type: 'ATTEMPT_DISPATCHING' });
  const { session: dispatched } = store.claimLaunchIntentAndCommitSession({
    runId: prepared.run_id,
    sessionId: ready.session_id,
    expectedRevision: ready.revision,
    eventType: 'ATTEMPT_DISPATCHING',
    nextState: dispatching,
  });
  let runtime;
  try {
    runtime = await launch({ prepared });
  } catch {
    return reconcileAmbiguous({ store, prepared, readback });
  }
  if (typeof runtime?.threadId !== 'string' || runtime.threadId.length === 0) {
    return reconcileAmbiguous({ store, prepared, readback });
  }
  let native;
  try {
    native = await readback({ prepared, runtime });
  } catch {
    return reconcileAmbiguous({ store, prepared, readback });
  }
  const turns = Array.isArray(native?.turns) ? native.turns : [];
  const persistedTurnId = turns[0]?.id;
  const persistedTurnInputSha256 = turns[0]?.input_sha256;
  const authorizedTurnIds = [persistedTurnId];
  if (native?.available !== true
    || native.thread_id !== runtime.threadId
    || typeof runtime?.turnId !== 'string'
    || runtime.turnId.length === 0
    || typeof runtime?.turnInputSha256 !== 'string'
    || !HASH.test(runtime.turnInputSha256)
    || !Array.isArray(runtime.initialTurnIds)
    || runtime.initialTurnIds.length !== 0
    || turns.length !== 1
    || typeof persistedTurnId !== 'string'
    || persistedTurnId.length === 0
    || persistedTurnInputSha256 !== runtime.turnInputSha256) {
    return reconcileAmbiguous({ store, prepared, readback: async () => native });
  }
  const receipt = createLaunchReceipt({
    intent: prepared.intent,
    threadId: runtime.threadId,
    turnStartResponseId: runtime.turnId,
    turnInputSha256: runtime.turnInputSha256,
    turnId: persistedTurnId,
    authorizedTurnIds,
    startedAt: now,
  });
  let attempt = realizeAttempt({ intent: prepared.intent, receipt });
  let next = dispatched;
  next = transitionSession(next, { type: 'ATTEMPT_LAUNCHED', turn_started: true });
  if (runtime.outcome === 'candidate') {
    attempt = transitionAttempt(attempt, { type: 'RUNTIME_COMPLETED' });
    attempt.candidate = structuredClone(runtime.candidate ?? {
      status: 'ready_for_postflight', remaining_work: false,
    });
    next = transitionSession(next, { type: 'ATTEMPT_CANDIDATE' });
  } else {
    attempt = transitionAttempt(attempt, { type: 'RUNTIME_TERMINATED' });
    attempt.completion_level = 'candidate';
    next = transitionSession(next, { type: 'ATTEMPT_TERMINAL' });
  }
  next.attempts.push(attempt);
  const committed = store.compareAndCommit({
    sessionId: next.session_id,
    expectedRevision: dispatched.revision,
    eventType: runtime.outcome === 'candidate' ? 'ATTEMPT_CANDIDATE' : 'ATTEMPT_LAUNCHED',
    nextState: next,
    blobs: [{ kind: 'launch-receipt', bytes: canonicalJson(receipt) }],
  });
  store.updateLaunchIntentStatus({ runId: prepared.run_id, status: 'launched' });
  return { disposition: runtime.outcome, session: committed, attempt, receipt, runtime };
}
