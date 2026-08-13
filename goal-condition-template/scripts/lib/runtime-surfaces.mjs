import { createHash } from 'node:crypto';

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

export function runtimeSurfaceDigests(sourceEntries) {
  classifyCoreFiles(REQUIRED_CORE_FILES);
  const entries = normalizedSourceEntries(sourceEntries);
  const forRuntime = (runtime) => entries.filter(({ path }) => {
    const capability = CORE_FILE_CAPABILITIES[path];
    return capability === 'runtime_shared' || capability === runtime;
  });
  const claude = forRuntime('claude');
  const codex = forRuntime('codex');
  if (claude.length === 0 || codex.length === 0) {
    throw new RuntimeSurfaceError('RUNTIME_SURFACE_EMPTY', 'runtime surface must not be empty');
  }
  return Object.freeze({
    claude: digestCanonical(claude),
    codex: digestCanonical(codex),
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
