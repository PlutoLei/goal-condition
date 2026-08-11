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
    || authorizedTurnIds.length === 0
    || nativeTurnIds.some((id) => typeof id !== 'string')) {
    return {
      disposition: 'reconciliation_required',
      relaunch_allowed: false,
      reason_codes: ['LAUNCH_RECEIPT_READBACK_MISMATCH'],
    };
  }
  const authorized = new Set(authorizedTurnIds);
  if (nativeTurnIds.some((id) => !authorized.has(id))) {
    return {
      disposition: 'control_plane_bypass',
      relaunch_allowed: false,
      reason_codes: ['UNRECEIPTED_NATIVE_TURN'],
    };
  }
  const nativeIds = new Set(nativeTurnIds);
  const allAuthorizedFound = authorizedTurnIds.every((id) => nativeIds.has(id));
  const turnFound = nativeIds.has(receipt.turn_id);
  if (receipt.run_id === intent?.run_id
    && native.thread_id === receipt.thread_id
    && turnFound
    && allAuthorizedFound) {
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
