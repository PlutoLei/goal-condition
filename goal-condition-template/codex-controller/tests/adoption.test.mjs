import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { adoptLegacyContract } from '../src/adoption.mjs';

test('legacy adoption creates an unconfirmed Draft with current-state provenance', async () => {
  const contract = JSON.parse(await readFile(
    new URL('../../tests/fixtures/valid-contract.json', import.meta.url), 'utf8',
  ));
  const result = adoptLegacyContract({
    contract,
    sessionId: 'adopted-session',
    currentStateDigest: 'a'.repeat(64),
    originalBaseline: null,
  });
  assert.equal(result.session.status, 'AwaitingConfirmation');
  assert.equal(result.session.confirmation_receipts.length, 0);
  assert.equal(result.provenance.baseline_provenance, 'adopted_at_current_state');
  assert.equal(result.provenance.legacy_confirmation, 'unverified');
  assert.equal(result.provenance.certifies_pre_adoption_state, false);
  assert.deepEqual(result.session.authority_revisions[0].authority.hard_prohibitions, []);
  assert.ok(result.session.non_goals.includes('Commands are previewed but never executed by validation.'));
});
