import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, rm, readFile, realpath, writeFile, rename, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inventoryLegacy } from '../scripts/legacy-inventory.mjs';

async function fixture(t, session, intent) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'native-inventory-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = join(root, 'state', 'synthetic-project', 'controller');
  await mkdir(store, { recursive: true });
  const path = join(store, 'sessions.db');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE sessions(status TEXT); CREATE TABLE launch_intents(status TEXT); CREATE TABLE target_leases(status TEXT);');
  db.prepare('INSERT INTO sessions VALUES (?)').run(session);
  if (intent) db.prepare('INSERT INTO launch_intents VALUES (?)').run(intent);
  db.close();
  return { root, path };
}

test('unlaunched draft is inventoried without changing the database', async (t) => {
  const f = await fixture(t, 'AwaitingConfirmation', null);
  const before = await readFile(f.path);
  const result = await inventoryLegacy(f.root, { processLines: [] });
  assert.equal(result.quiescent, true);
  assert.equal(result.stores[0].sessions[0].status, 'AwaitingConfirmation');
  assert.deepEqual(await readFile(f.path), before);
});
for (const state of ['Running', 'Dispatching', 'Evaluating', 'ReconciliationRequired']) {
  test(`${state} is not silently migrated`, async (t) => {
    const f = await fixture(t, state, null);
    assert.equal((await inventoryLegacy(f.root, { processLines: [] })).quiescent, false);
  });
}
test('an unfinished intent blocks switching even if the session says Ready', async (t) => {
  const f = await fixture(t, 'Ready', 'dispatching');
  assert.equal((await inventoryLegacy(f.root, { processLines: [] })).quiescent, false);
});
test('closed history is retained; process readback can still block migration', async (t) => {
  const f = await fixture(t, 'Complete', 'closed');
  assert.equal((await inventoryLegacy(f.root, { processLines: [] })).quiescent, true);
  const result = await inventoryLegacy(f.root, { processLines: [`999999 node ${f.root}/wrapper/cli.mjs launch --session-id synthetic`] });
  assert.equal(result.quiescent, false);
  assert.deepEqual(result.process_ids, [999999]);
  assert.equal(JSON.stringify(result).includes('--session-id'), false);
});
test('retained RPC logs alone are historical; a live pointer still blocks', async (t) => {
  const f = await fixture(t, 'Ready', 'closed');
  const dir = join(f.root, 'runtime', 'synthetic');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'rpc-envelopes.jsonl'), 'history must survive');
  let result = await inventoryLegacy(f.root, { processLines: [] });
  assert.equal(result.quiescent, true);
  assert.equal(result.historical_logs, 1);
  await writeFile(join(dir, 'codex-home.path'), 'live pointer');
  result = await inventoryLegacy(f.root, { processLines: [] });
  assert.equal(result.quiescent, false);
  assert.equal(await readFile(join(dir, 'rpc-envelopes.jsonl'), 'utf8'), 'history must survive');
});
test('a controller parent symlink is rejected without opening its store', async (t) => {
  const f = await fixture(t, 'Ready', 'closed');
  const original = join(f.root, 'state', 'synthetic-project', 'controller');
  const moved = join(f.root, 'preserved');
  await rename(original, moved);
  await symlink(moved, original);
  const result = await inventoryLegacy(f.root, { processLines: [] });
  assert.equal(result.quiescent, false);
  assert.deepEqual(result.stores, []);
});
