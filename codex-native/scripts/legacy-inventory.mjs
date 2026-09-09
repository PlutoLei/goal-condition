#!/usr/bin/env node
import { readdir, lstat, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

async function entries(path) {
  try { return await readdir(path, { withFileTypes: true }); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}

// Metadata only: never read task prompts, credentials, or raw runtime log contents.
export async function inventoryLegacy(baseRoot, { processLines } = {}) {
  const root = resolve(baseRoot);
  const result = { exists: existsSync(root), stores: [], markers: [], historical_logs: 0, process_ids: [], blockers: [] };
  async function physical(path) {
    const stat = await lstat(path).catch((e) => { if (e.code === 'ENOENT') return null; throw e; });
    if (!stat) return false;
    if (stat.isSymbolicLink() || await realpath(path) !== path) {
      result.blockers.push('LEGACY_PATH_SYMLINK');
      return false;
    }
    return true;
  }
  if (result.exists && !await physical(root)) return { ...result, quiescent: false };
  const state = join(root, 'state');
  for (const project of await physical(state) ? await entries(state) : []) {
    if (project.isSymbolicLink()) { result.blockers.push('STATE_SYMLINK'); continue; }
    if (!project.isDirectory()) continue;
    const dbPath = join(state, project.name, 'controller', 'sessions.db');
    if (!await physical(join(state, project.name, 'controller')) || !await physical(dbPath)) continue;
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((x) => x.name));
      const store = { project: project.name };
      for (const table of ['sessions', 'target_leases', 'launch_intents']) {
        store[table] = tables.has(table)
          ? db.prepare(`SELECT status, COUNT(*) AS count FROM ${table} GROUP BY status`).all() : [];
      }
      if (!tables.has('sessions')) result.blockers.push('LEGACY_STORE_UNRECOGNIZED');
      if (store.target_leases.some((x) => x.status !== 'released' && x.count > 0)
          || store.launch_intents.some((x) => x.status !== 'closed' && x.count > 0)
          || store.sessions.some((x) => ['Dispatching', 'Running', 'Evaluating', 'ReconciliationRequired'].includes(x.status))) {
        result.blockers.push('LEGACY_WORK_NOT_QUIESCENT');
      }
      result.stores.push(store);
    } finally { db.close(); }
  }
  async function walk(dir) {
    for (const item of await entries(dir)) {
      if (item.isSymbolicLink()) { result.blockers.push('RUNTIME_SYMLINK'); continue; }
      if (item.isDirectory()) await walk(join(dir, item.name));
      // The legacy close routine removes live pointers, but retains RPC logs as history.
      else if (item.name === 'rpc-envelopes.jsonl') result.historical_logs++;
      else if (['lease.json', 'codex-home.path', 'cleanup-pending.json'].includes(item.name)) {
        result.markers.push(item.name);
      }
    }
  }
  if (await physical(join(root, 'runtime'))) await walk(join(root, 'runtime'));
  if (result.markers.length) result.blockers.push('RUNTIME_MARKERS_REQUIRE_REVIEW');
  let lines = processLines;
  if (lines === undefined) {
    try { lines = execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n'); }
    catch { result.blockers.push('PROCESS_READBACK_UNAVAILABLE'); lines = []; }
  }
  for (const line of lines) {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    if (match && Number(match[1]) !== process.pid && match[2].includes(root)
        && /(?:\s|\/)(?:launch|resume|app-server)(?:\s|$)/.test(match[2])) result.process_ids.push(Number(match[1]));
  }
  if (result.process_ids.length) result.blockers.push('LEGACY_PROCESS_PRESENT');
  result.quiescent = result.blockers.length === 0;
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('one legacy root required');
    const result = await inventoryLegacy(process.argv[2]);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.quiescent ? 0 : 1;
  } catch { process.stderr.write('LEGACY_INVENTORY_FAILED\n'); process.exitCode = 1; }
}
