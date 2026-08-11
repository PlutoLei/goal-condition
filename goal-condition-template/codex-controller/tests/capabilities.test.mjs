import assert from 'node:assert/strict';
import test from 'node:test';

import { assessCapabilities } from '../src/capabilities.mjs';

const enforcedProbes = {
  sandbox: {
    type: 'workspaceWrite',
    writableRoots: [],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  },
  controller_state_outside_targets: true,
  thread_read: true,
  turn_readback: true,
};

test('known Codex mechanisms satisfy only the hard prohibitions they enforce', () => {
  const report = assessCapabilities({
    probes: enforcedProbes,
    hardProhibitions: [
      { id: 'no-network', capability: 'network-deny' },
      { id: 'target-only', capability: 'workspace-write-boundary' },
      { id: 'controller-private', capability: 'controller-state-isolation' },
    ],
  });
  assert.equal(report.launchable, true);
  assert.deepEqual(report.hard_prohibitions.map((item) => item.level), [
    'ENFORCED', 'ENFORCED', 'ENFORCED',
  ]);
  assert.equal(report.capabilities['native-turn-readback'].level, 'DETECTED');
});

test('unknown, declared, or merely detected mechanisms cannot satisfy a hard prohibition', () => {
  const report = assessCapabilities({
    probes: { ...enforcedProbes, turn_readback: false },
    hardProhibitions: [
      { id: 'production', capability: 'no-production-deploy' },
      { id: 'readback', capability: 'native-turn-readback' },
    ],
  });
  assert.equal(report.launchable, false);
  assert.deepEqual(report.reason_codes, [
    'HARD_PROHIBITION_NOT_ENFORCED:no-production-deploy',
    'HARD_PROHIBITION_NOT_ENFORCED:native-turn-readback',
  ]);
});
