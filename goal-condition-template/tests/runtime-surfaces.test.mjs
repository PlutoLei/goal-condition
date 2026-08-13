import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  CAPABILITY_CLASSES,
  CORE_FILE_CAPABILITIES,
  REQUIRED_CORE_FILES,
  RuntimeSurfaceError,
  classifyCoreFiles,
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
