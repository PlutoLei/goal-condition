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
  const turnFound = turns.some((turn) => turn?.id === receipt.turn_id);
  if (receipt.run_id === intent?.run_id
    && native.thread_id === receipt.thread_id
    && turnFound) {
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
