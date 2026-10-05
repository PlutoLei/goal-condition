#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inventoryLegacy } from './legacy-inventory.mjs';

const names = ['goal-condition', 'boundary-design'];
const bundle = resolve(import.meta.dirname, '../skills');
const hash = (x) => createHash('sha256').update(x).digest('hex');
const present = async (p) => Boolean(await lstat(p).catch((e) => { if (e.code === 'ENOENT') return null; throw e; }));
function fail(code) { throw Object.assign(new Error(code), { code }); }

async function physicalDirectory(p) {
  if (resolve(p).split('/').includes('.claude')) fail('CLAUDE_PATH_FORBIDDEN');
  let ancestor = resolve(p);
  while (!await present(ancestor)) ancestor = dirname(ancestor);
  if (await realpath(ancestor) !== ancestor) fail('INSTALL_PATH_NOT_PHYSICAL');
  await mkdir(p, { recursive: true });
  if ((await lstat(p)).isSymbolicLink() || await realpath(p) !== resolve(p)) fail('INSTALL_PATH_NOT_PHYSICAL');
  if (resolve(p).split('/').includes('.claude')) fail('CLAUDE_PATH_FORBIDDEN');
}

async function inventory(dir) {
  const files = {};
  async function walk(path, rel) {
    const s = await lstat(path);
    if (s.isSymbolicLink()) fail('SKILL_SYMLINK_FORBIDDEN');
    if (s.isDirectory()) {
      for (const entry of (await readdir(path)).sort()) await walk(join(path, entry), rel ? `${rel}/${entry}` : entry);
    } else if (s.isFile()) files[rel] = hash(await readFile(path));
    else fail('SKILL_ENTRY_INVALID');
  }
  await walk(dir, '');
  if (!files['SKILL.md']) fail('SKILL_ENTRY_MISSING');
  return files;
}

async function identity(path) {
  if (!await present(path)) return null;
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) return { link: await readlink(path) };
  if (!stat.isDirectory()) fail('SKILL_ENTRY_INVALID');
  return { files: await inventory(path) };
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function paths(home) {
  const root = resolve(home);
  return { root, skills: join(root, 'skills'), owned: join(root, 'adaptations', 'native-goal-install') };
}

async function readReceipt(owned) {
  if (!existsSync(join(owned, 'current.json'))) return null;
  const data = JSON.parse(await readFile(join(owned, 'current.json'), 'utf8'));
  if (data.version !== 1 || !/^\d+-[a-f0-9]+$/.test(data.id)
      || !Array.isArray(data.entries) || !same(data.entries.map((x) => x.name), names)
      || !['prepared', 'installed', 'rolled-back'].includes(data.phase)) fail('RECEIPT_INVALID');
  return data;
}

async function saveReceipt(owned, receipt) {
  const temp = join(owned, 'current.tmp');
  await writeFile(temp, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, join(owned, 'current.json'));
  await writeFile(join(owned, receipt.id, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
}

export async function installationStatus(codexHome) {
  const p = paths(codexHome);
  const receipt = await readReceipt(p.owned);
  if (!receipt || receipt.phase === 'rolled-back') return { installed: false, phase: receipt?.phase ?? 'absent' };
  const drift = [];
  for (const e of receipt.entries) {
    try { if (!same(await identity(join(p.skills, e.name)), { files: e.files })) drift.push(e.name); }
    catch { drift.push(e.name); }
  }
  return { installed: receipt.phase === 'installed' && drift.length === 0, phase: receipt.phase, drift, id: receipt.id };
}

async function withLock(p, action) {
  await physicalDirectory(p.root);
  await physicalDirectory(p.skills);
  await physicalDirectory(p.owned);
  const lock = join(p.owned, 'lock');
  try { await mkdir(lock); } catch (e) { if (e.code === 'EEXIST') fail('INSTALL_LOCKED'); throw e; }
  try { return await action(); } finally { await rm(lock, { recursive: true }); }
}

async function restore(p, receipt) {
  const backups = join(p.owned, receipt.id, 'previous');
  // Check all targets before moving any entry. Only exact installed bytes may be removed.
  for (const e of receipt.entries) {
    const current = await identity(join(p.skills, e.name));
    if (current !== null && !same(current, { files: e.files }) && !same(current, e.previous)) fail('ROLLBACK_DRIFT');
    const backup = join(backups, e.name);
    if (await present(backup)) {
      if (!same(await identity(backup), e.previous)) fail('BACKUP_DRIFT');
    } else if (e.previous !== null && !same(current, e.previous)) fail('BACKUP_MISSING');
  }
  for (const e of [...receipt.entries].reverse()) {
    const target = join(p.skills, e.name);
    const backup = join(backups, e.name);
    if (await present(backup)) {
      if (await present(target)) await rm(target, { recursive: true });
      await rename(backup, target);
    } else if (e.previous === null && await present(target)) {
      await rm(target, { recursive: true });
    }
  }
  receipt.phase = 'rolled-back';
  await saveReceipt(p.owned, receipt);
  if (receipt.previous_receipt?.phase === 'installed') {
    await saveReceipt(p.owned, receipt.previous_receipt);
  }
  return { rolled_back: true, id: receipt.id };
}

export async function installNative({ codexHome, source = bundle, processLines, afterInstallEntry } = {}) {
  const p = paths(codexHome);
  return withLock(p, async () => {
    const legacy = await inventoryLegacy(join(p.root, 'goal-condition'), { processLines });
    if (!legacy.quiescent) fail('LEGACY_NOT_QUIESCENT');
    const prior = await readReceipt(p.owned);
    if (prior?.phase === 'prepared') fail('INSTALL_RECOVERY_REQUIRED');
    if (prior?.phase === 'installed' && !(await installationStatus(p.root)).installed) fail('INSTALLED_SKILL_DRIFT');
    const entries = [];
    for (const name of names) {
      const files = await inventory(join(source, name));
      const previous = await identity(join(p.skills, name));
      if (previous !== null && prior?.phase !== 'installed'
          && !same(previous, { link: join(p.root, 'goal-condition', 'active', name) })) fail('UNOWNED_SKILL_ENTRY');
      entries.push({ name, files, previous });
    }
    if (prior?.phase === 'installed' && entries.every((e) => same(e.previous, { files: e.files }))) return { installed: true, unchanged: true, id: prior.id };
    const receipt = { version: 1, id: `${Date.now()}-${randomBytes(6).toString('hex')}`, phase: 'prepared', entries,
      previous_receipt: prior?.phase === 'installed' ? prior : null };
    const backup = join(p.owned, receipt.id, 'previous');
    const stage = join(p.owned, receipt.id, 'stage');
    await mkdir(backup, { recursive: true, mode: 0o700 });
    await mkdir(stage);
    for (const e of entries) {
      await cp(join(source, e.name), join(stage, e.name), { recursive: true, dereference: false });
      if (!same(await inventory(join(stage, e.name)), e.files)) fail('SOURCE_CHANGED');
    }
    await saveReceipt(p.owned, receipt);
    try {
      for (const e of entries) {
        const target = join(p.skills, e.name);
        if (!same(await identity(target), e.previous)) fail('INSTALL_TARGET_CHANGED');
        if (e.previous !== null) await rename(target, join(backup, e.name));
        await rename(join(stage, e.name), target);
        if (afterInstallEntry) await afterInstallEntry(e.name);
      }
      receipt.phase = 'installed';
      await saveReceipt(p.owned, receipt);
      return await installationStatus(p.root);
    } catch (e) {
      await restore(p, receipt);
      throw e;
    }
  });
}

export async function rollbackNative(codexHome) {
  const p = paths(codexHome);
  return withLock(p, async () => {
    const receipt = await readReceipt(p.owned);
    if (!receipt || receipt.phase === 'rolled-back') fail('NO_INSTALLATION_TO_ROLL_BACK');
    return restore(p, receipt);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [action, flag, value, ...extra] = process.argv.slice(2);
    if (!['install', 'status', 'rollback', 'inspect'].includes(action)
        || (flag !== undefined && (flag !== '--codex-home' || !value)) || extra.length) fail('USAGE: install.mjs install|status|rollback|inspect [--codex-home PATH]');
    const home = value ?? process.env.CODEX_HOME ?? join(homedir(), '.codex');
    const result = action === 'install' ? await installNative({ codexHome: home })
      : action === 'rollback' ? await rollbackNative(home)
        : action === 'inspect' ? await inventoryLegacy(join(resolve(home), 'goal-condition'))
          : await installationStatus(home);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (action === 'status' && !result.installed) process.exitCode = 1;
    if (action === 'inspect' && !result.quiescent) process.exitCode = 1;
  } catch (e) { process.stderr.write(`${e.code ?? 'NATIVE_INSTALL_FAILED'}\n`); process.exitCode = 1; }
}
