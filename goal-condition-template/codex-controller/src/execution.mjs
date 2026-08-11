import { createHash } from 'node:crypto';

import { canonicalJson, contractHash } from '../../scripts/lib/contract.mjs';
import {
  createLaunchIntent,
  createLaunchReceipt,
  realizeAttempt,
} from './attempt.mjs';
import { transitionAttempt, transitionSession } from './domain.mjs';
import { projectAttempt } from './projector.mjs';
import { reconcileLaunch } from './recovery.mjs';

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
    turn_text: [
      'Execute this immutable GoalSession Attempt. The Controller, not this executor, certifies completion.',
      `Context Package SHA-256: ${projection.contextPackage.sha256}`,
      projection.contextPackage.bytes,
      `Projection Proof SHA-256: ${projection.projectionProof.sha256}`,
      projection.projectionProof.bytes,
    ].join('\n\n'),
  };
}

export function prepareControlledAttempt({
  store, sessionId, attemptId, workspaceDigest, runId, expiresAt, nonce,
  capabilityReport,
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
  store.persistLaunchIntent({
    intent,
    roots: session.design_revisions.at(-1).active_boundary.target_roots,
    ownerToken,
    writable: session.design_revisions.at(-1).active_boundary.actions.includes('write'),
  });
  return {
    session_id: sessionId,
    attempt_id: attemptId,
    run_id: runId,
    intent,
    owner_token: ownerToken,
    projection,
    runtime_prompt: attemptRuntimePrompt(projection),
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

export async function launchControlledAttempt({ store, prepared, launch, readback, now }) {
  const stored = intentWithoutStatus(store.readLaunchIntent(prepared.run_id));
  if (canonicalJson(stored) !== canonicalJson(prepared.intent)) {
    throw executionError('LAUNCH_INTENT_MISMATCH', 'prepared intent does not match durable state');
  }
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
  const turn = turns.at(-1);
  if (native?.available !== true || native.thread_id !== runtime.threadId || typeof turn?.id !== 'string') {
    return reconcileAmbiguous({ store, prepared, readback: async () => native });
  }
  const receipt = createLaunchReceipt({
    intent: prepared.intent,
    threadId: runtime.threadId,
    turnId: turn.id,
    startedAt: now,
  });
  let attempt = realizeAttempt({ intent: prepared.intent, receipt });
  let next = store.read(prepared.session_id);
  next = transitionSession(next, { type: 'ATTEMPT_LAUNCHED', turn_started: true });
  if (runtime.outcome === 'candidate') {
    attempt = transitionAttempt(attempt, { type: 'RUNTIME_COMPLETED' });
    attempt.candidate = structuredClone(runtime.candidate ?? { status: 'ready_for_postflight' });
    next = transitionSession(next, { type: 'ATTEMPT_CANDIDATE' });
  }
  next.attempts.push(attempt);
  const committed = store.compareAndCommit({
    sessionId: next.session_id,
    expectedRevision: store.read(next.session_id).revision,
    eventType: runtime.outcome === 'candidate' ? 'ATTEMPT_CANDIDATE' : 'ATTEMPT_LAUNCHED',
    nextState: next,
    blobs: [{ kind: 'launch-receipt', bytes: canonicalJson(receipt) }],
  });
  store.updateLaunchIntentStatus({ runId: prepared.run_id, status: 'launched' });
  return { disposition: runtime.outcome, session: committed, attempt, receipt, runtime };
}
