export function reconcileLaunch({ intent, receipt, native }) {
  if (native?.available !== true) {
    return {
      disposition: 'reconciliation_required',
      relaunch_allowed: false,
      reason_codes: ['NATIVE_READBACK_UNAVAILABLE'],
    };
  }
  const turns = Array.isArray(native.turns) ? native.turns : [];
  if (receipt === null || receipt === undefined) {
    if (turns.length === 0) {
      return {
        disposition: 'not_started',
        relaunch_allowed: true,
        reason_codes: ['NATIVE_TURN_ABSENT'],
      };
    }
    return {
      disposition: 'control_plane_bypass',
      relaunch_allowed: false,
      reason_codes: ['CONTROL_PLANE_BYPASS'],
    };
  }
  const nativeTurnIds = turns.map((turn) => turn?.id);
  const authorizedTurnIds = receipt.authorized_turn_ids;
  const receiptVersion = receipt.receipt_version ?? 2;
  const receiptLineageValid = Array.isArray(authorizedTurnIds)
    && authorizedTurnIds.length > 0
    && authorizedTurnIds[0] === receipt.turn_id
    && authorizedTurnIds.every((id) => typeof id === 'string' && id.length > 0)
    && new Set(authorizedTurnIds).size === authorizedTurnIds.length
    && ((receiptVersion === 2 && authorizedTurnIds.length === 1)
      || (receiptVersion === 3 && authorizedTurnIds.length > 1));
  if (!Array.isArray(authorizedTurnIds)
    || !receiptLineageValid
    || typeof receipt.turn_input_sha256 !== 'string'
    || !/^[0-9a-f]{64}$/.test(receipt.turn_input_sha256)
    || nativeTurnIds.some((id) => typeof id !== 'string' || id.length === 0)
    || new Set(nativeTurnIds).size !== nativeTurnIds.length) {
    return {
      disposition: 'reconciliation_required',
      relaunch_allowed: false,
      reason_codes: ['LAUNCH_RECEIPT_READBACK_MISMATCH'],
    };
  }
  const expectedTurns = receiptVersion === 3
    ? authorizedTurnIds.map((id, index) => (index === 0
      ? { id, input_sha256: receipt.turn_input_sha256, input_kind: 'controller' }
      : { id, input_sha256: null, input_kind: 'continuation' }))
    : [{ id: receipt.turn_id, input_sha256: receipt.turn_input_sha256 }];
  const observedKeys = turns.map((turn) => JSON.stringify(receiptVersion === 3 ? {
    id: turn.id, input_sha256: turn.input_sha256, input_kind: turn.input_kind,
  } : { id: turn.id, input_sha256: turn.input_sha256 }));
  const expectedKeys = expectedTurns.map((turn) => JSON.stringify(turn));
  const expectedSet = new Set(expectedKeys);
  if (observedKeys.some((key) => !expectedSet.has(key))) {
    return {
      disposition: 'control_plane_bypass',
      relaunch_allowed: false,
      reason_codes: ['UNRECEIPTED_NATIVE_TURN'],
    };
  }
  if (receipt.run_id === intent?.run_id
    && native.thread_id === receipt.thread_id
    && observedKeys.length === expectedKeys.length
    && expectedKeys.every((key, index) => observedKeys[index] === key)) {
    return {
      disposition: 'continue_evaluating',
      relaunch_allowed: false,
      reason_codes: [],
    };
  }
  return {
    disposition: 'reconciliation_required',
    relaunch_allowed: false,
    reason_codes: ['LAUNCH_RECEIPT_READBACK_MISMATCH'],
  };
}
