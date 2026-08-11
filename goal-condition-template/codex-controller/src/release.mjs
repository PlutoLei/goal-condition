import { createHash } from 'node:crypto';
import {
  existsSync, lstatSync, readFileSync, readdirSync, realpathSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson } from '../../scripts/lib/contract.mjs';

const HASH = /^[0-9a-f]{64}$/;
const MANIFEST_FIELDS = Object.freeze(['schema_version', 'commit', 'source_files', 'profile_sha256']);
const SOURCE_FIELDS = Object.freeze(['path', 'mode', 'sha256']);
const CHECKOUT_ROOTS = Object.freeze([
  'SKILL.md',
  'codex-controller/package.json',
  'codex-controller/schema',
  'codex-controller/src',
  'references',
  'schema',
  'scripts',
]);

function releaseError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function exactFields(value, fields) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.hasOwn(value, field));
}

function safeRelativePath(path) {
  return typeof path === 'string'
    && path.length > 0
    && !path.startsWith('/')
    && path.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
}

function inside(root, candidate) {
  const delta = relative(root, candidate);
  return delta !== '' && delta !== '..' && !delta.startsWith(`..${sep}`) && !delta.startsWith(sep);
}

function readBoundFile(root, path) {
  if (!safeRelativePath(path)) throw releaseError('RELEASE_MANIFEST_INVALID', 'release path is invalid');
  const candidate = resolve(root, path);
  if (!inside(root, candidate)) throw releaseError('RELEASE_MANIFEST_INVALID', 'release path escapes its root');
  const stat = lstatSync(candidate);
  if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(candidate) !== candidate) {
    throw releaseError('RELEASE_FILE_INVALID', `release file ${path} must be physical and regular`);
  }
  return readFileSync(candidate);
}

function installedManifestDigest(root, manifestPath) {
  const raw = readBoundFile(root, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(raw.toString('utf8'));
  } catch {
    throw releaseError('RELEASE_MANIFEST_INVALID', 'release manifest is not valid JSON');
  }
  if (!exactFields(manifest, MANIFEST_FIELDS)
    || manifest.schema_version !== 1
    || !Array.isArray(manifest.source_files)
    || !HASH.test(manifest.profile_sha256 ?? '')) {
    throw releaseError('RELEASE_MANIFEST_INVALID', 'release manifest has an invalid closed-world shape');
  }
  const seen = new Set();
  for (const source of manifest.source_files) {
    if (!exactFields(source, SOURCE_FIELDS)
      || !safeRelativePath(source.path)
      || !['100644', '100755'].includes(source.mode)
      || !HASH.test(source.sha256 ?? '')
      || seen.has(source.path)
      || sha256(readBoundFile(root, source.path)) !== source.sha256) {
      throw releaseError('RELEASE_SOURCE_DRIFT', 'release source no longer matches its manifest');
    }
    seen.add(source.path);
  }
  if (!seen.has('codex-controller/src/release.mjs')
    || sha256(readBoundFile(root, 'references/anchors-and-rules.md')) !== manifest.profile_sha256) {
    throw releaseError('RELEASE_SOURCE_DRIFT', 'release core or private profile is incomplete');
  }
  if (resolve(manifestPath) !== resolve(root, 'manifest.json')) {
    throw releaseError('RELEASE_MANIFEST_INVALID', 'release manifest path is inconsistent');
  }
  return sha256(raw);
}

function collectCheckoutFiles(root, path, output) {
  const absolute = resolve(root, path);
  const stat = lstatSync(absolute);
  if (stat.isSymbolicLink() || realpathSync(absolute) !== absolute) {
    throw releaseError('CHECKOUT_SOURCE_INVALID', 'checkout source must not traverse symlinks');
  }
  if (stat.isFile()) {
    output.push({ path, sha256: sha256(readFileSync(absolute)) });
    return;
  }
  if (!stat.isDirectory()) throw releaseError('CHECKOUT_SOURCE_INVALID', 'checkout source must be regular');
  for (const name of readdirSync(absolute).sort()) {
    const child = path === '' ? name : `${path}/${name}`;
    if (child.includes('/tests/') || child.endsWith('.test.mjs')) continue;
    collectCheckoutFiles(root, child, output);
  }
}

function checkoutDigest(root) {
  const files = [];
  for (const path of CHECKOUT_ROOTS) {
    if (existsSync(resolve(root, path))) collectCheckoutFiles(root, path, files);
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  if (!files.some((entry) => entry.path === 'codex-controller/src/release.mjs')) {
    throw releaseError('CHECKOUT_SOURCE_INVALID', 'checkout release identity is incomplete');
  }
  return sha256(canonicalJson({ kind: 'source-checkout', files }));
}

export function currentControllerReleaseDigest() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const manifestPath = join(root, 'manifest.json');
  return existsSync(manifestPath)
    ? installedManifestDigest(root, manifestPath)
    : checkoutDigest(root);
}
