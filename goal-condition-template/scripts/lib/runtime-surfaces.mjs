import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync, lstatSync, readFileSync, realpathSync,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import { canonicalJson } from './contract.mjs';

export const CAPABILITY_CLASSES = Object.freeze([
  'release_only', 'runtime_shared', 'claude', 'codex',
]);

const capabilityEntries = [
  ['SKILL.md', 'release_only'],
  ['codex-controller/package.json', 'codex'],
  ['codex-controller/schema/goal-session-v2.schema.json', 'codex'],
  ['codex-controller/schema/revision-operation-v1.schema.json', 'codex'],
  ['codex-controller/src/attempt.mjs', 'codex'],
  ['codex-controller/src/capabilities.mjs', 'codex'],
  ['codex-controller/src/cli.mjs', 'codex'],
  ['codex-controller/src/compiler.mjs', 'codex'],
  ['codex-controller/src/domain.mjs', 'codex'],
  ['codex-controller/src/evidence.mjs', 'codex'],
  ['codex-controller/src/execution.mjs', 'codex'],
  ['codex-controller/src/identity.mjs', 'codex'],
  ['codex-controller/src/index.mjs', 'codex'],
  ['codex-controller/src/migration.mjs', 'codex'],
  ['codex-controller/src/policy.mjs', 'codex'],
  ['codex-controller/src/projector.mjs', 'codex'],
  ['codex-controller/src/recovery.mjs', 'codex'],
  ['codex-controller/src/release.mjs', 'codex'],
  ['codex-controller/src/rollout.mjs', 'codex'],
  ['codex-controller/src/state-root.mjs', 'codex'],
  ['codex-controller/src/store.mjs', 'codex'],
  ['codex-controller/src/values.mjs', 'codex'],
  ['codex-controller/src/verification.mjs', 'codex'],
  ['references/codex-goal-session-v2.md', 'release_only'],
  ['references/run-contract.md', 'release_only'],
  ['references/adapters/claude.md', 'release_only'],
  ['references/adapters/codex.md', 'release_only'],
  ['schema/run-contract.schema.json', 'runtime_shared'],
  ['scripts/validate-contract.mjs', 'runtime_shared'],
  ['scripts/snapshot.mjs', 'runtime_shared'],
  ['scripts/install.mjs', 'release_only'],
  ['scripts/lib/contract.mjs', 'runtime_shared'],
  ['scripts/lib/snapshot.mjs', 'runtime_shared'],
  ['scripts/lib/installer.mjs', 'release_only'],
  ['scripts/lib/runtime-surfaces.mjs', 'runtime_shared'],
  ['scripts/lib/workflow.mjs', 'runtime_shared'],
  ['scripts/launch.mjs', 'runtime_shared'],
  ['scripts/lib/adapters/claude.mjs', 'claude'],
  ['scripts/lib/adapters/codex.mjs', 'codex'],
  ['scripts/lib/claude-permissions.mjs', 'claude'],
];

export const CORE_FILE_CAPABILITIES = Object.freeze(Object.fromEntries(capabilityEntries));
export const REQUIRED_CORE_FILES = Object.freeze(capabilityEntries.map(([path]) => path));

const SHA256 = /^[0-9a-f]{64}$/;
const SOURCE_FIELDS = Object.freeze(['mode', 'path', 'sha256']);
const SURFACE_FIELDS = Object.freeze(['claude', 'codex']);

export class RuntimeSurfaceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'RuntimeSurfaceError';
    this.code = code;
    Object.assign(this, details);
  }
}

function digestCanonical(value) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sameFields(value, fields) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.hasOwn(value, field));
}

export function classifyCoreFiles(paths, capabilities = CORE_FILE_CAPABILITIES) {
  if (!Array.isArray(paths)) {
    throw new RuntimeSurfaceError('CORE_CAPABILITY_INPUT_INVALID', 'core file list must be an array');
  }
  if (capabilities === null || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
    throw new RuntimeSurfaceError('CORE_CAPABILITY_MAP_INVALID', 'capability map must be an object');
  }
  const groups = Object.fromEntries(CAPABILITY_CLASSES.map((capability) => [capability, []]));
  const seen = new Set();
  for (const path of paths) {
    if (typeof path !== 'string' || path.length === 0) {
      throw new RuntimeSurfaceError('CORE_CAPABILITY_PATH_INVALID', 'core file path must be non-empty');
    }
    if (seen.has(path)) {
      throw new RuntimeSurfaceError('CORE_CAPABILITY_DUPLICATE', 'core file is classified more than once');
    }
    seen.add(path);
    const capability = capabilities[path];
    if (!CAPABILITY_CLASSES.includes(capability)) {
      throw new RuntimeSurfaceError('CORE_CAPABILITY_UNKNOWN', 'core file has no known capability class');
    }
    groups[capability].push(path);
  }
  const capabilityPaths = Object.keys(capabilities);
  if (capabilityPaths.length !== paths.length
    || capabilityPaths.some((path) => !seen.has(path))) {
    throw new RuntimeSurfaceError('CORE_CAPABILITY_CLOSURE_MISMATCH', 'capability map and required core set differ');
  }
  for (const capability of CAPABILITY_CLASSES) {
    groups[capability].sort();
    if (groups[capability].length === 0) {
      throw new RuntimeSurfaceError('CORE_CAPABILITY_SURFACE_EMPTY', 'capability class must not be empty');
    }
  }
  return Object.freeze(Object.fromEntries(
    CAPABILITY_CLASSES.map((capability) => [capability, Object.freeze(groups[capability])]),
  ));
}

function normalizedSourceEntries(sourceEntries) {
  if (!Array.isArray(sourceEntries) || sourceEntries.length === 0) {
    throw new RuntimeSurfaceError('RUNTIME_SURFACE_SOURCE_INVALID', 'source entries must be non-empty');
  }
  const expected = new Set(REQUIRED_CORE_FILES);
  const seen = new Set();
  const normalized = [];
  for (const entry of sourceEntries) {
    if (!sameFields(entry, SOURCE_FIELDS)
      || !expected.has(entry?.path)
      || !['100644', '100755'].includes(entry?.mode)
      || !SHA256.test(entry?.sha256 ?? '')
      || seen.has(entry?.path)) {
      throw new RuntimeSurfaceError(
        'RUNTIME_SURFACE_SOURCE_INVALID',
        'source entries must exactly cover the classified release core',
      );
    }
    seen.add(entry.path);
    normalized.push({ path: entry.path, mode: entry.mode, sha256: entry.sha256 });
  }
  if (seen.size !== expected.size || [...expected].some((path) => !seen.has(path))) {
    throw new RuntimeSurfaceError(
      'RUNTIME_SURFACE_SOURCE_INVALID',
      'source entries must exactly cover the classified release core',
    );
  }
  normalized.sort((left, right) => left.path.localeCompare(right.path));
  return normalized;
}

function runtimePaths(runtime) {
  if (!['claude', 'codex'].includes(runtime)) {
    throw new RuntimeSurfaceError('RUNTIME_SURFACE_RUNTIME_INVALID', 'runtime must be claude or codex');
  }
  return REQUIRED_CORE_FILES.filter((path) => {
    const capability = CORE_FILE_CAPABILITIES[path];
    return capability === 'runtime_shared' || capability === runtime;
  });
}

function digestRuntimeEntries(runtime, entries) {
  const expected = runtimePaths(runtime);
  const selected = entries.filter(({ path }) => expected.includes(path));
  if (selected.length !== expected.length
    || expected.some((path) => !selected.some((entry) => entry.path === path))) {
    throw new RuntimeSurfaceError('RUNTIME_SURFACE_EMPTY', 'runtime surface is incomplete');
  }
  selected.sort((left, right) => left.path.localeCompare(right.path));
  return digestCanonical(selected);
}

export function runtimeSurfaceDigests(sourceEntries) {
  classifyCoreFiles(REQUIRED_CORE_FILES);
  const entries = normalizedSourceEntries(sourceEntries);
  return Object.freeze({
    claude: digestRuntimeEntries('claude', entries),
    codex: digestRuntimeEntries('codex', entries),
  });
}

export function validateRuntimeSurfaces(manifest) {
  const declared = manifest?.runtime_surfaces;
  if (!sameFields(declared, SURFACE_FIELDS)
    || !SHA256.test(declared?.claude ?? '')
    || !SHA256.test(declared?.codex ?? '')) {
    throw new RuntimeSurfaceError(
      'RUNTIME_SURFACE_SHAPE_INVALID',
      'runtime surfaces must have exact Claude and Codex digests',
    );
  }
  const computed = runtimeSurfaceDigests(manifest?.source_files);
  if (computed.claude !== declared.claude || computed.codex !== declared.codex) {
    throw new RuntimeSurfaceError(
      'RUNTIME_SURFACE_DIGEST_MISMATCH',
      'runtime surface digest does not match manifest source entries',
    );
  }
  return computed;
}

function physicalRoot(root) {
  if (typeof root !== 'string' || root.length === 0) {
    throw new RuntimeSurfaceError('RUNTIME_SOURCE_ROOT_INVALID', 'runtime source root must be a path');
  }
  let canonical;
  try {
    canonical = realpathSync(resolve(root));
    const stat = lstatSync(canonical);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('not physical');
  } catch {
    throw new RuntimeSurfaceError('RUNTIME_SOURCE_ROOT_INVALID', 'runtime source root must be physical');
  }
  return canonical;
}

function physicalFile(root, path) {
  const pathname = resolve(root, path);
  const delta = relative(root, pathname);
  if (delta === '' || delta === '..' || delta.startsWith(`..${sep}`) || delta.startsWith(sep)) {
    throw new RuntimeSurfaceError('RUNTIME_SOURCE_PATH_INVALID', 'runtime source path escapes its root');
  }
  let stat;
  try {
    stat = lstatSync(pathname);
    if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(pathname) !== pathname) throw new Error('not physical');
  } catch {
    throw new RuntimeSurfaceError('RUNTIME_SOURCE_FILE_INVALID', 'runtime source file must be physical');
  }
  return { pathname, stat, bytes: readFileSync(pathname) };
}

function expectedFilesystemMode(gitMode) {
  return gitMode === '100755' ? 0o755 : 0o644;
}

function inspectImmutableRelease(root, runtime, expectedManifestDigest) {
  if (!SHA256.test(expectedManifestDigest ?? '')) {
    throw new RuntimeSurfaceError(
      'RELEASE_MANIFEST_DIGEST_REQUIRED',
      'immutable runtime source requires an external manifest digest',
    );
  }
  const manifestFile = physicalFile(root, 'manifest.json');
  const manifestDigest = sha256(manifestFile.bytes);
  if (manifestDigest !== expectedManifestDigest) {
    throw new RuntimeSurfaceError(
      'RELEASE_MANIFEST_DIGEST_MISMATCH',
      'immutable runtime source does not match the external manifest digest',
    );
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestFile.bytes.toString('utf8'));
  } catch {
    throw new RuntimeSurfaceError('RELEASE_MANIFEST_INVALID', 'release manifest is not valid JSON');
  }
  const manifestFields = ['commit', 'profile_sha256', 'runtime_surfaces', 'schema_version', 'source_files'];
  if (!sameFields(manifest, manifestFields)
    || manifest.schema_version !== 2
    || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(manifest.commit ?? '')
    || !SHA256.test(manifest.profile_sha256 ?? '')) {
    throw new RuntimeSurfaceError('RELEASE_MANIFEST_INVALID', 'release manifest is not schema v2');
  }
  const surfaces = validateRuntimeSurfaces(manifest);
  for (const entry of manifest.source_files) {
    const current = physicalFile(root, entry.path);
    if (sha256(current.bytes) !== entry.sha256
      || (current.stat.mode & 0o7777) !== expectedFilesystemMode(entry.mode)) {
      throw new RuntimeSurfaceError('RELEASE_SOURCE_DRIFT', 'release source no longer matches its manifest');
    }
  }
  const profile = physicalFile(root, 'references/anchors-and-rules.md');
  if (sha256(profile.bytes) !== manifest.profile_sha256 || (profile.stat.mode & 0o7777) !== 0o600) {
    throw new RuntimeSurfaceError('RELEASE_SOURCE_DRIFT', 'release private profile no longer matches its manifest');
  }
  return {
    source: {
      kind: 'immutable_release', root_realpath: root, manifest_digest: manifestDigest,
    },
    releaseManifestDigest: manifestDigest,
    runtimeSurfaceDigest: surfaces[runtime],
  };
}

function git(root, args, options = {}) {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding: options.encoding ?? 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw new RuntimeSurfaceError(
      'CHECKOUT_SOURCE_INVALID',
      'checkout runtime source could not be read from Git',
      { exitCode: error?.status },
    );
  }
}

function inspectGitCheckout(root, runtime) {
  const gitRoot = realpathSync(git(root, ['rev-parse', '--show-toplevel']).trim());
  const relativeTemplate = relative(gitRoot, root);
  if (relativeTemplate === '' || relativeTemplate === '..'
    || relativeTemplate.startsWith(`..${sep}`) || relativeTemplate.startsWith(sep)) {
    throw new RuntimeSurfaceError('CHECKOUT_SOURCE_INVALID', 'runtime source is not inside its Git checkout');
  }
  const commit = git(gitRoot, ['rev-parse', '--verify', 'HEAD^{commit}']).trim();
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(commit)) {
    throw new RuntimeSurfaceError('CHECKOUT_SOURCE_INVALID', 'checkout HEAD is not a full commit');
  }
  const selectedPaths = runtimePaths(runtime);
  const gitPaths = selectedPaths.map((path) => `${relativeTemplate.split(sep).join('/')}/${path}`);
  try {
    execFileSync('git', ['-C', gitRoot, 'diff', '--quiet', 'HEAD', '--', ...gitPaths], {
      stdio: ['ignore', 'ignore', 'ignore'],
    });
  } catch (error) {
    if (error?.status === 1) {
      throw new RuntimeSurfaceError('CHECKOUT_RUNTIME_DIRTY', 'runtime material differs from checkout HEAD');
    }
    throw new RuntimeSurfaceError('CHECKOUT_SOURCE_INVALID', 'checkout runtime diff could not be verified');
  }
  const entries = selectedPaths.map((path, index) => {
    const gitPath = gitPaths[index];
    const record = git(gitRoot, ['ls-tree', '-z', commit, '--', gitPath], { encoding: 'buffer' })
      .toString('utf8').replace(/\0$/, '');
    const match = /^(100644|100755) blob [0-9a-f]{40,64}\t(.+)$/.exec(record);
    if (!match || match[2] !== gitPath) {
      throw new RuntimeSurfaceError('CHECKOUT_SOURCE_INVALID', 'checkout runtime file is not a regular HEAD blob');
    }
    const bytes = git(gitRoot, ['show', '--no-textconv', `${commit}:${gitPath}`], { encoding: 'buffer' });
    const current = physicalFile(root, path);
    if (sha256(current.bytes) !== sha256(bytes)
      || (current.stat.mode & 0o7777) !== expectedFilesystemMode(match[1])) {
      throw new RuntimeSurfaceError('CHECKOUT_RUNTIME_DIRTY', 'runtime material differs from checkout HEAD');
    }
    return { path, mode: match[1], sha256: sha256(bytes) };
  });
  return {
    source: { kind: 'git_checkout', root_realpath: root, commit },
    releaseManifestDigest: null,
    runtimeSurfaceDigest: digestRuntimeEntries(runtime, entries),
  };
}

export function inspectRuntimeSource({ root, runtime, expectedManifestDigest } = {}) {
  runtimePaths(runtime);
  const canonicalRoot = physicalRoot(root);
  return existsSync(join(canonicalRoot, 'manifest.json'))
    ? inspectImmutableRelease(canonicalRoot, runtime, expectedManifestDigest)
    : inspectGitCheckout(canonicalRoot, runtime);
}
