import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, readFile, readlink, writeFile, rm, cp, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { installNative, installationStatus, rollbackNative } from '../scripts/install.mjs';

async function setup(t, { legacy = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'native-goal-test-'));
  // macOS temp paths have a system alias; the installer uses physical paths.
  const { realpath } = await import('node:fs/promises');
  const home = join(await realpath(root), 'codex');
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(home, 'skills'), { recursive: true });
  if (legacy) {
    for (const name of ['goal-condition', 'boundary-design']) {
      const target = join(home, 'goal-condition', 'active', name);
      await mkdir(target, { recursive: true });
      await writeFile(join(target, 'SKILL.md'), 'immutable old skill');
      await symlink(target, join(home, 'skills', name));
    }
  }
  return { home, codexHome: home, processLines: [] };
}

test('first install needs no project registry and creates physical skill entries', async (t) => {
  const opts = await setup(t, { legacy: false });
  assert.equal((await installNative(opts)).installed, true);
  assert.equal((await lstat(join(opts.home, 'skills', 'goal-condition'))).isDirectory(), true);
  assert.equal((await installationStatus(opts.home)).installed, true);
});
test('legacy links are backed up without editing their immutable targets', async (t) => {
  const opts = await setup(t);
  const old = join(opts.home, 'goal-condition', 'active', 'goal-condition', 'SKILL.md');
  assert.equal((await installNative(opts)).installed, true);
  assert.equal(await readFile(old, 'utf8'), 'immutable old skill');
  assert.equal((await installNative(opts)).unchanged, true);
  await rollbackNative(opts.home);
  assert.equal(await readlink(join(opts.home, 'skills', 'goal-condition')), join(opts.home, 'goal-condition', 'active', 'goal-condition'));
  assert.equal((await installationStatus(opts.home)).phase, 'rolled-back');
});
test('failure between skills restores both prior entries', async (t) => {
  const opts = await setup(t);
  await assert.rejects(installNative({ ...opts, afterInstallEntry: () => { throw new Error('injected'); } }), /injected/);
  for (const name of ['goal-condition', 'boundary-design']) {
    assert.equal(await readlink(join(opts.home, 'skills', name)), join(opts.home, 'goal-condition', 'active', name));
  }
});
test('foreign skill directories are preserved', async (t) => {
  const opts = await setup(t, { legacy: false });
  const path = join(opts.home, 'skills', 'goal-condition');
  await mkdir(path); await writeFile(join(path, 'SKILL.md'), 'user work');
  await assert.rejects(installNative(opts), /UNOWNED_SKILL_ENTRY/);
  assert.equal(await readFile(join(path, 'SKILL.md'), 'utf8'), 'user work');
});
test('installation and rollback detect edited installed skills', async (t) => {
  const opts = await setup(t);
  await installNative(opts);
  const path = join(opts.home, 'skills', 'goal-condition', 'SKILL.md');
  await writeFile(path, 'user changes');
  assert.equal((await installationStatus(opts.home)).installed, false);
  await assert.rejects(installNative(opts), /INSTALLED_SKILL_DRIFT/);
  await assert.rejects(rollbackNative(opts.home), /ROLLBACK_DRIFT/);
  assert.equal(await readFile(path, 'utf8'), 'user changes');
});
test('updates can roll back to the previously installed native release', async (t) => {
  const opts = await setup(t);
  const first = await installNative(opts);
  const source = join(opts.home, 'candidate');
  await cp(resolve(import.meta.dirname, '../skills'), source, { recursive: true });
  const path = join(source, 'goal-condition', 'SKILL.md');
  await writeFile(path, (await readFile(path, 'utf8')) + '\nCandidate clarification.\n');
  await installNative({ ...opts, source });
  await rollbackNative(opts.home);
  assert.equal((await installationStatus(opts.home)).id, first.id);
  assert.equal((await installationStatus(opts.home)).installed, true);
});
test('uncertain legacy runtime metadata blocks switching and is not removed', async (t) => {
  const opts = await setup(t);
  const runtime = join(opts.home, 'goal-condition', 'runtime', 'existing');
  await mkdir(runtime, { recursive: true });
  await writeFile(join(runtime, 'cleanup-pending.json'), 'do not parse or delete');
  await assert.rejects(installNative(opts), /LEGACY_NOT_QUIESCENT/);
  assert.equal(await readFile(join(runtime, 'cleanup-pending.json'), 'utf8'), 'do not parse or delete');
});
test('Claude paths and symlinked installation parents are rejected', async (t) => {
  const opts = await setup(t, { legacy: false });
  await assert.rejects(installNative({ ...opts, codexHome: join(opts.home, '.claude') }), /CLAUDE_PATH_FORBIDDEN/);
  const link = join(opts.home, 'alias'); await symlink(join(opts.home, 'skills'), link);
  await assert.rejects(installNative({ ...opts, codexHome: link }), /INSTALL_PATH_NOT_PHYSICAL/);
});
