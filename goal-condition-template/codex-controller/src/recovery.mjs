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
  if (!Array.isArray(authorizedTurnIds)
    || authorizedTurnIds.length !== 1
    || authorizedTurnIds[0] !== receipt.turn_id
    || typeof receipt.turn_input_sha256 !== 'string'
    || !/^[0-9a-f]{64}$/.test(receipt.turn_input_sha256)
    || nativeTurnIds.some((id) => typeof id !== 'string' || id.length === 0)
    || new Set(nativeTurnIds).size !== nativeTurnIds.length
    || turns.some((turn) => typeof turn?.input_sha256 !== 'string'
      || !/^[0-9a-f]{64}$/.test(turn.input_sha256))) {
    return {
      disposition: 'reconciliation_required',
      relaunch_allowed: false,
      reason_codes: ['LAUNCH_RECEIPT_READBACK_MISMATCH'],
    };
  }
  if (turns.some((turn) => turn.id !== receipt.turn_id
    || turn.input_sha256 !== receipt.turn_input_sha256)) {
    return {
      disposition: 'control_plane_bypass',
      relaunch_allowed: false,
      reason_codes: ['UNRECEIPTED_NATIVE_TURN'],
    };
  }
  if (receipt.run_id === intent?.run_id
    && native.thread_id === receipt.thread_id
    && turns.length === 1) {
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
