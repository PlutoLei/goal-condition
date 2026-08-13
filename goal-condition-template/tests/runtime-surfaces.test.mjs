import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';

import {
  CAPABILITY_CLASSES,
  CORE_FILE_CAPABILITIES,
  REQUIRED_CORE_FILES,
  RuntimeSurfaceError,
  classifyCoreFiles,
  inspectRuntimeSource,
  runtimeSurfaceDigests,
  validateRuntimeSurfaces,
} from '../scripts/lib/runtime-surfaces.mjs';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sourceEntries() {
  return REQUIRED_CORE_FILES.map((path, index) => ({
    path,
    mode: index % 2 === 0 ? '100644' : '100755',
    sha256: sha256(`source:${path}`),
  }));
}

function mutate(entries, path) {
  return entries.map((entry) => entry.path === path
    ? { ...entry, sha256: sha256(`changed:${path}`) }
    : entry);
}

test('every static runtime import stays inside its declared capability closure', () => {
  const templateRoot = realpathSync(new URL('..', import.meta.url));
  const allowed = {
    runtime_shared: new Set(['runtime_shared']),
    claude: new Set(['runtime_shared', 'claude']),
    codex: new Set(['runtime_shared', 'codex']),
  };
  for (const [sourcePath, sourceCapability] of Object.entries(CORE_FILE_CAPABILITIES)) {
    if (!(sourceCapability in allowed) || !sourcePath.endsWith('.mjs')) continue;
    const source = readFileSync(join(templateRoot, sourcePath), 'utf8');
    const specifiers = [
      ...source.matchAll(/\bfrom\s+['"](\.[^'"]+\.mjs)['"]/g),
      ...source.matchAll(/\bimport\s+['"](\.[^'"]+\.mjs)['"]/g),
    ].map((match) => match[1]);
    for (const specifier of specifiers) {
      const targetPath = relative(templateRoot, resolve(dirname(join(templateRoot, sourcePath)), specifier))
        .split('\\').join('/');
      const targetCapability = CORE_FILE_CAPABILITIES[targetPath];
      assert.ok(targetCapability, `${sourcePath} statically imports unclassified ${targetPath}`);
      assert.ok(
        allowed[sourceCapability].has(targetCapability),
        `${sourcePath} (${sourceCapability}) statically imports ${targetPath} (${targetCapability})`,
      );
    }
  }
});

test('every required release file has exactly one closed-world capability class', () => {
  assert.deepEqual(CAPABILITY_CLASSES, ['release_only', 'runtime_shared', 'claude', 'codex']);
  assert.deepEqual(Object.keys(CORE_FILE_CAPABILITIES).sort(), [...REQUIRED_CORE_FILES].sort());
  assert.equal(CORE_FILE_CAPABILITIES['SKILL.md'], 'release_only');
  assert.equal(CORE_FILE_CAPABILITIES['scripts/lib/contract.mjs'], 'runtime_shared');
  assert.equal(CORE_FILE_CAPABILITIES['scripts/lib/adapters/claude.mjs'], 'claude');
  assert.equal(CORE_FILE_CAPABILITIES['scripts/lib/adapters/codex.mjs'], 'codex');

  const classified = classifyCoreFiles(REQUIRED_CORE_FILES);
  assert.equal(classified.release_only.length > 0, true);
  assert.equal(classified.runtime_shared.length > 0, true);
  assert.equal(classified.claude.length > 0, true);
  assert.equal(classified.codex.length > 0, true);
  assert.equal(Object.values(classified).flat().length, REQUIRED_CORE_FILES.length);
});

test('runtime surface digests isolate release-only, Claude-only, Codex-only, and shared changes', () => {
  const entries = sourceEntries();
  const original = runtimeSurfaceDigests(entries);
  const releaseOnlyPath = 'SKILL.md';
  const sharedPath = 'scripts/lib/contract.mjs';
  const claudePath = 'scripts/lib/adapters/claude.mjs';
  const codexPath = 'scripts/lib/adapters/codex.mjs';

  const releaseOnly = runtimeSurfaceDigests(mutate(entries, releaseOnlyPath));
  assert.deepEqual(releaseOnly, original);

  const shared = runtimeSurfaceDigests(mutate(entries, sharedPath));
  assert.notEqual(shared.claude, original.claude);
  assert.notEqual(shared.codex, original.codex);

  const claude = runtimeSurfaceDigests(mutate(entries, claudePath));
  assert.notEqual(claude.claude, original.claude);
  assert.equal(claude.codex, original.codex);

  const codex = runtimeSurfaceDigests(mutate(entries, codexPath));
  assert.equal(codex.claude, original.claude);
  assert.notEqual(codex.codex, original.codex);
});

test('runtime surface inputs fail closed on missing, duplicate, unknown, malformed, or empty material', () => {
  const entries = sourceEntries();
  const cases = [
    entries.slice(1),
    [...entries, entries[0]],
    [...entries, { path: 'scripts/lib/unknown.mjs', mode: '100644', sha256: sha256('unknown') }],
    entries.map((entry, index) => index === 0 ? { ...entry, mode: '100600' } : entry),
    entries.map((entry, index) => index === 0 ? { ...entry, sha256: 'A'.repeat(64) } : entry),
  ];
  for (const value of cases) {
    assert.throws(
      () => runtimeSurfaceDigests(value),
      (error) => error instanceof RuntimeSurfaceError,
    );
  }
  assert.throws(
    () => classifyCoreFiles(['scripts/lib/unknown.mjs']),
    (error) => error.code === 'CORE_CAPABILITY_UNKNOWN',
  );
});

test('manifest runtime surfaces are recomputed from source entries instead of trusted by declaration', () => {
  const source_files = sourceEntries();
  const runtime_surfaces = runtimeSurfaceDigests(source_files);
  assert.deepEqual(validateRuntimeSurfaces({ source_files, runtime_surfaces }), runtime_surfaces);
  assert.throws(
    () => validateRuntimeSurfaces({
      source_files,
      runtime_surfaces: { ...runtime_surfaces, claude: '0'.repeat(64) },
    }),
    (error) => error.code === 'RUNTIME_SURFACE_DIGEST_MISMATCH',
  );
  assert.throws(
    () => validateRuntimeSurfaces({ source_files, runtime_surfaces: { ...runtime_surfaces, extra: '0'.repeat(64) } }),
    (error) => error.code === 'RUNTIME_SURFACE_SHAPE_INVALID',
  );
});

test('a checkout runtime identity is Git-bound and rejects runtime worktree drift', (t) => {
  const parent = mkdtempSync(join(tmpdir(), 'goal-runtime-source-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const template = join(parent, 'goal-condition-template');
  for (const path of REQUIRED_CORE_FILES) {
    const pathname = join(template, path);
    mkdirSync(dirname(pathname), { recursive: true });
    writeFileSync(pathname, `source:${path}\n`);
    if (path === 'scripts/install.mjs') chmodSync(pathname, 0o755);
  }
  execFileSync('git', ['-C', parent, 'init', '--initial-branch=main']);
  execFileSync('git', ['-C', parent, 'config', 'user.name', 'Runtime Source Test']);
  execFileSync('git', ['-C', parent, 'config', 'user.email', 'runtime-source@example.invalid']);
  execFileSync('git', ['-C', parent, 'add', '.']);
  execFileSync('git', ['-C', parent, 'commit', '-m', 'runtime source']);
  const commit = execFileSync('git', ['-C', parent, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  const identity = inspectRuntimeSource({ root: template, runtime: 'claude' });
  assert.deepEqual(identity.source, {
    kind: 'git_checkout', root_realpath: realpathSync(template), commit,
  });
  assert.equal(identity.releaseManifestDigest, null);
  assert.match(identity.runtimeSurfaceDigest, /^[0-9a-f]{64}$/);

  writeFileSync(join(template, 'scripts/lib/adapters/claude.mjs'), 'drift\n');
  assert.throws(
    () => inspectRuntimeSource({ root: template, runtime: 'claude' }),
    (error) => error.code === 'CHECKOUT_RUNTIME_DIRTY',
  );
  assert.doesNotThrow(() => inspectRuntimeSource({ root: template, runtime: 'codex' }));
});
