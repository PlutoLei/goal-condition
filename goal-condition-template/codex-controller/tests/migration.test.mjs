import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { migrateV1Contract } from '../src/migration.mjs';
import { snapshotDigest } from '../../scripts/lib/snapshot.mjs';

test('v1 migration creates an unconfirmed V2 Draft without importing certification', async () => {
  const contract = JSON.parse(await readFile(
    new URL('../../tests/fixtures/valid-contract.json', import.meta.url), 'utf8',
  ));
  const result = migrateV1Contract({
    contract,
    sessionId: 'migrated-session',
    currentStateDigest: 'a'.repeat(64),
    originalBaseline: null,
  });
  assert.equal(result.session.status, 'AwaitingConfirmation');
  assert.equal(result.session.confirmation_receipts.length, 0);
  assert.equal(result.provenance.baseline_provenance, 'migrated_at_current_state');
  assert.equal(result.provenance.legacy_confirmation, 'unverified');
  assert.equal(result.provenance.certifies_pre_migration_state, false);
  assert.deepEqual(result.session.authority_revisions[0].authority.hard_prohibitions, []);
  assert.ok(result.session.non_goals.includes('Commands are previewed but never executed by validation.'));
});

test('provided v1 baseline is content-bound instead of trusting an embedded digest field', async () => {
  const contract = JSON.parse(await readFile(
    new URL('../../tests/fixtures/valid-contract.json', import.meta.url), 'utf8',
  ));
  const originalBaseline = { baseline_version: 1, entries: [], digest: 'f'.repeat(64) };
  const currentStateDigest = snapshotDigest(originalBaseline);
  const result = migrateV1Contract({
    contract,
    sessionId: 'migrated-original-baseline',
    currentStateDigest,
    originalBaseline,
  });
  assert.equal(result.session.root_baseline.kind, 'v1-original');
  assert.equal(result.session.root_baseline.digest, currentStateDigest);
  assert.notEqual(result.session.root_baseline.digest, originalBaseline.digest);
  assert.equal(result.provenance.certifies_pre_migration_state, false);
});
