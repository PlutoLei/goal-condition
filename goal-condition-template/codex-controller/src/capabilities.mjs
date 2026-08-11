import { exactFields } from './values.mjs';

const LEVELS = new Set(['ENFORCED', 'DETECTED', 'DECLARED', 'UNAVAILABLE']);
const SANDBOX_FIELDS = Object.freeze([
  'type', 'writableRoots', 'networkAccess', 'excludeTmpdirEnvVar', 'excludeSlashTmp',
]);

function capability(level, reason) {
  if (!LEVELS.has(level)) throw new TypeError(`unknown capability level ${level}`);
  return { level, reason };
}

function exactWorkspaceSandbox(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    exactFields(value, SANDBOX_FIELDS, 'sandbox');
  } catch {
    return false;
  }
  return value.type === 'workspaceWrite'
    && Array.isArray(value.writableRoots)
    && value.writableRoots.length === 0
    && value.networkAccess === false
    && value.excludeTmpdirEnvVar === false
    && value.excludeSlashTmp === false;
}

export function assessCapabilities({ probes = {}, hardProhibitions = [] } = {}) {
  const sandboxExact = exactWorkspaceSandbox(probes.sandbox);
  const capabilities = {
    'workspace-write-boundary': sandboxExact
      ? capability('ENFORCED', 'Codex workspaceWrite sandbox is exact and closed-world verified.')
      : capability('UNAVAILABLE', 'The workspace sandbox cannot be verified exactly.'),
    'network-deny': sandboxExact && probes.sandbox.networkAccess === false
      ? capability('ENFORCED', 'The verified Codex sandbox disables network access.')
      : capability('UNAVAILABLE', 'Network denial is not mechanically verified.'),
    'controller-state-isolation': probes.controller_state_outside_targets === true
      ? capability('ENFORCED', 'Controller state is outside every executor-writable target root.')
      : capability('UNAVAILABLE', 'Controller state isolation is not established.'),
    'native-thread-readback': probes.thread_read === true
      ? capability('DETECTED', 'Native thread state can be read after the side effect.')
      : capability('UNAVAILABLE', 'Native thread readback is unavailable.'),
    'native-turn-readback': probes.turn_readback === true
      ? capability('DETECTED', 'Native turns can be detected but not prevented.')
      : capability('UNAVAILABLE', 'Native turn readback is unavailable.'),
  };

  const hard = hardProhibitions.map((item) => {
    const observed = capabilities[item?.capability]
      ?? capability('UNAVAILABLE', 'No controller-verified mechanism is registered for this prohibition.');
    return {
      id: item?.id ?? 'unknown',
      capability: item?.capability ?? 'unknown',
      level: observed.level,
      satisfied: observed.level === 'ENFORCED',
    };
  });
  const reasonCodes = hard
    .filter((item) => !item.satisfied)
    .map((item) => `HARD_PROHIBITION_NOT_ENFORCED:${item.capability}`);
  return {
    launchable: reasonCodes.length === 0,
    capabilities,
    hard_prohibitions: hard,
    reason_codes: reasonCodes,
  };
}
