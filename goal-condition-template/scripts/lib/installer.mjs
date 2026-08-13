import { createHash, randomBytes } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { constants } from 'node:fs';
import {
  chmod, lstat, mkdir, open, readFile, readlink, readdir, realpath, rename, rmdir, symlink, unlink, writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import {
  REQUIRED_CORE_FILES, runtimeSurfaceDigests, validateRuntimeSurfaces,
} from './runtime-surfaces.mjs';

export { REQUIRED_CORE_FILES } from './runtime-surfaces.mjs';

const execFile = promisify(execFileCallback);
const TEMPLATE_ROOT = 'goal-condition-template/';
const MANIFEST_NAME = 'manifest.json';
export const PROFILE_PATH = 'references/anchors-and-rules.md';
const RELEASE_DIRECTORY_MODE = 0o755;
const PROFILE_MODE = 0o600;
const MANIFEST_MODE = 0o644;
const LOCK_WAIT_MS = 20;
const LOCK_TIMEOUT_MS = 10_000;
const REQUIRED_CORE_SET = new Set(REQUIRED_CORE_FILES);
const SHA256 = /^[0-9a-f]{64}$/;

export class InstallerError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'InstallerError';
    this.code = code;
    Object.assign(this, details);
  }
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function exactMode(stat) {
  return (stat.mode & 0o7777).toString(8).padStart(4, '0');
}

function inside(root, candidate, allowRoot = true) {
  const pathRelative = relative(root, candidate);
  return (allowRoot || pathRelative.length > 0)
    && pathRelative !== '..'
    && !pathRelative.startsWith(`..${sep}`)
    && !pathRelative.startsWith(sep);
}

function overlaps(left, right) {
  return inside(left, right) || inside(right, left);
}

async function canonicalExistingParent(pathname) {
  let ancestor = dirname(resolve(pathname));
  const suffix = [basename(resolve(pathname))];
  while (true) {
    try {
      return resolve(await realpath(ancestor), ...suffix);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw new InstallerError('PATH_CANONICALIZATION_FAILED', `no existing parent for ${pathname}`);
      suffix.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
}

async function pathForms(pathname, exact = false) {
  const lexical = resolve(pathname);
  const canonical = exact ? await realpath(lexical) : await canonicalExistingParent(lexical);
  return { lexical, canonical };
}

async function captureParentIdentity(pathname, name) {
  const parent = dirname(pathname);
  let stat;
  try {
    stat = await lstat(parent);
  } catch {
    throw new InstallerError('LINK_PARENT_INVALID', 'runtime link parent must exist', { link: name });
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new InstallerError('LINK_PARENT_INVALID', 'runtime link parent must be a physical directory', { link: name });
  }
  return { path: parent, dev: stat.dev, ino: stat.ino, realpath: await realpath(parent) };
}

async function assertStableParent(link, phase) {
  let stat;
  try {
    stat = await lstat(link.parentIdentity.path);
  } catch {
    throw new InstallerError('LINK_PARENT_IDENTITY_CHANGED', 'runtime link parent identity changed', {
      link: link.name, phase,
    });
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || stat.dev !== link.parentIdentity.dev || stat.ino !== link.parentIdentity.ino
    || await realpath(link.parentIdentity.path) !== link.parentIdentity.realpath) {
    throw new InstallerError('LINK_PARENT_IDENTITY_CHANGED', 'runtime link parent identity changed', {
      link: link.name, phase,
    });
  }
}

async function captureAncestorIdentity(pathname, code) {
  let ancestor = dirname(pathname);
  while (true) {
    try {
      const stat = await lstat(ancestor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new InstallerError(code, 'protected path ancestor must be a physical directory');
      }
      return { path: ancestor, dev: stat.dev, ino: stat.ino, realpath: await realpath(ancestor) };
    } catch (error) {
      if (error instanceof InstallerError) throw error;
      if (error?.code !== 'ENOENT') throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw new InstallerError(code, 'protected path has no stable existing ancestor');
      ancestor = parent;
    }
  }
}

async function captureDirectoryIdentity(pathname, code) {
  let stat;
  try {
    stat = await lstat(pathname);
  } catch {
    throw new InstallerError(code, 'protected directory is unavailable');
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new InstallerError(code, 'protected directory must be physical');
  }
  return { path: pathname, dev: stat.dev, ino: stat.ino, realpath: await realpath(pathname) };
}

async function assertStableDirectory(identity, code, phase) {
  let stat;
  try {
    stat = await lstat(identity.path);
  } catch {
    throw new InstallerError(code, 'protected directory identity changed', { phase });
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || stat.dev !== identity.dev || stat.ino !== identity.ino
    || await realpath(identity.path) !== identity.realpath) {
    throw new InstallerError(code, 'protected directory identity changed', { phase });
  }
}

function formsOverlap(left, right) {
  return [left.lexical, left.canonical].some((leftPath) => [right.lexical, right.canonical]
    .some((rightPath) => overlaps(leftPath, rightPath)));
}

function wait(milliseconds) {
  return new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

function safeRelativePath(pathname) {
  return typeof pathname === 'string'
    && pathname.length > 0
    && !isAbsolute(pathname)
    && pathname.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
}

function sourceRelativePath(pathname) {
  if (!pathname.startsWith(TEMPLATE_ROOT)) return null;
  const candidate = pathname.slice(TEMPLATE_ROOT.length);
  if (!safeRelativePath(candidate)) return null;
  return REQUIRED_CORE_SET.has(candidate) ? candidate : null;
}

function validateArguments({ repo, ref, profile, releaseRoot, links, backupRoot }) {
  const required = { repo, ref, profile, releaseRoot };
  for (const [field, value] of Object.entries(required)) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new InstallerError('INSTALL_ARGUMENT_INVALID', `${field} must be a non-empty path or ref`, { field });
    }
  }
  if (links === null || typeof links !== 'object' || Array.isArray(links) || Object.keys(links).length === 0) {
    throw new InstallerError('INSTALL_ARGUMENT_INVALID', 'links must map runtime names to paths', { field: 'links' });
  }
  for (const [name, target] of Object.entries(links)) {
    if (!/^[A-Za-z0-9_-]+$/.test(name) || typeof target !== 'string' || target.length === 0) {
      throw new InstallerError('INSTALL_ARGUMENT_INVALID', 'each link needs a safe name and non-empty path', { field: 'links', link: name });
    }
  }
  if (backupRoot !== undefined && (typeof backupRoot !== 'string' || backupRoot.length === 0)) {
    throw new InstallerError('INSTALL_ARGUMENT_INVALID', 'backupRoot must be a non-empty path when supplied', { field: 'backupRoot' });
  }
}

async function regularFile(pathname, code, details = {}) {
  let stat;
  try {
    stat = await lstat(pathname);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new InstallerError(code, `${pathname} must exist`, details);
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new InstallerError(code, `${pathname} must be a regular file`, details);
  }
}

async function captureProfile(pathname) {
  if (typeof constants.O_NOFOLLOW !== 'number') {
    throw new InstallerError('PROFILE_NOFOLLOW_UNAVAILABLE', 'platform cannot safely open profile without following symlinks');
  }
  let handle;
  try {
    handle = await open(pathname, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile()) throw new InstallerError('PROFILE_INVALID', 'profile descriptor must be a regular file');
    const contents = await handle.readFile();
    return { handle, contents, identity: { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs } };
  } catch (error) {
    if (handle) await handle.close();
    if (error instanceof InstallerError) throw error;
    throw new InstallerError('PROFILE_OPEN_FAILED', 'profile must remain a readable non-symlink regular file', { observed: error?.code });
  }
}

async function directory(pathname, code, details = {}) {
  let stat;
  try {
    stat = await lstat(pathname);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new InstallerError(code, `${pathname} must exist`, details);
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new InstallerError(code, `${pathname} must be a non-symlink directory`, details);
  }
}

async function git(repo, args, options = {}) {
  try {
    return await execFile('git', ['-C', repo, ...args], {
      encoding: options.encoding ?? 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    throw new InstallerError(
      'GIT_SOURCE_READ_FAILED',
      `Git source read failed for ${args.join(' ')}`,
      { cause: error, observed: error?.stderr?.toString() ?? error?.message },
    );
  }
}

async function resolveCommit(repo, ref) {
  const { stdout } = await git(repo, ['rev-parse', '--verify', `${ref}^{commit}`]);
  const commit = stdout.trim();
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(commit)) {
    throw new InstallerError('GIT_COMMIT_INVALID', 'resolved ref is not a full Git commit hash', { observed: commit });
  }
  return commit;
}

function parseTree(output) {
  const entries = [];
  for (const record of output.toString('utf8').split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    const fields = record.slice(0, tab).split(' ');
    if (tab < 0 || fields.length !== 3) {
      throw new InstallerError('GIT_TREE_INVALID', 'Git returned an unreadable tree record');
    }
    const [mode, type, object] = fields;
    const sourcePath = record.slice(tab + 1);
    const targetPath = sourceRelativePath(sourcePath);
    if (!targetPath) continue;
    if (type !== 'blob' || !['100644', '100755'].includes(mode) || !/^[0-9a-f]{40,64}$/.test(object)) {
      throw new InstallerError('GIT_TREE_INVALID', `core source ${sourcePath} must be a regular blob`, { sourcePath });
    }
    entries.push({ sourcePath, targetPath, mode });
  }
  entries.sort((left, right) => left.targetPath.localeCompare(right.targetPath));
  const found = new Set(entries.map((entry) => entry.targetPath));
  const missing = REQUIRED_CORE_FILES.filter((pathname) => !found.has(pathname));
  if (missing.length > 0) {
    throw new InstallerError('CORE_SOURCE_MISSING', 'requested commit does not contain the complete runtime core', { missing });
  }
  return entries;
}

async function readCoreFiles(repo, commit) {
  const tree = await git(repo, ['ls-tree', '-r', '-z', commit, '--', 'goal-condition-template'], { encoding: 'buffer' });
  const entries = parseTree(tree.stdout);
  return Promise.all(entries.map(async ({ sourcePath, targetPath, mode }) => {
    const { stdout } = await git(repo, ['show', '--no-textconv', `${commit}:${sourcePath}`], { encoding: 'buffer' });
    return { path: targetPath, mode, contents: stdout, sha256: digest(stdout) };
  }));
}

function manifestFor(commit, sourceFiles, profileSha256) {
  const sourceEntries = sourceFiles.map(({ path, mode, sha256 }) => ({ path, mode, sha256 }));
  return {
    schema_version: 2,
    commit,
    source_files: sourceEntries,
    profile_sha256: profileSha256,
    runtime_surfaces: runtimeSurfaceDigests(sourceEntries),
  };
}

function manifestBytes(manifest) {
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function digestManifest(manifest) {
  return digest(manifestBytes(manifest));
}

function manifestsMatch(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function existing(pathname) {
  try {
    return await lstat(pathname);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function sameIdentity(stat, identity) {
  return stat.dev === identity.dev && stat.ino === identity.ino;
}

async function ownedIdentity(pathname) {
  const stat = await lstat(pathname);
  return { dev: stat.dev, ino: stat.ino };
}

async function makeOwnedDirectory(root, relativePath, ownedDirectories) {
  let current = root;
  for (const part of relativePath.split('/').filter(Boolean)) {
    current = join(current, part);
    if (ownedDirectories.has(current)) continue;
    let created = false;
    try {
      await mkdir(current, { mode: RELEASE_DIRECTORY_MODE });
      created = true;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    if (created) ownedDirectories.set(current, await ownedIdentity(current));
    await chmod(current, RELEASE_DIRECTORY_MODE);
  }
}

async function cleanupOwnedRelease(temporary, temporaryIdentity, ownedFiles, ownedDirectories) {
  let current;
  try {
    current = await lstat(temporary);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (!sameIdentity(current, temporaryIdentity)) return;
  for (const owned of [...ownedFiles].reverse()) {
    try {
      if (sameIdentity(await lstat(owned.path), owned.identity)) await unlink(owned.path);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  for (const [pathname, identity] of [...ownedDirectories.entries()].sort(([left], [right]) => right.length - left.length)) {
    try {
      if (sameIdentity(await lstat(pathname), identity)) await rmdir(pathname);
    } catch (error) {
      if (!['ENOENT', 'ENOTEMPTY'].includes(error?.code)) throw error;
    }
  }
  try {
    if (sameIdentity(await lstat(temporary), temporaryIdentity)) await rmdir(temporary);
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY'].includes(error?.code)) throw error;
  }
}

async function writeRelease(releaseRoot, releaseDir, sourceFiles, profileContents, manifest, releaseRootIdentity) {
  await assertStableDirectory(releaseRootIdentity, 'RELEASE_ROOT_IDENTITY_CHANGED', 'release-stage');
  const temporary = join(releaseRoot, `.${manifest.commit}.installing-${process.pid}-${randomBytes(8).toString('hex')}`);
  await mkdir(temporary, { mode: 0o700 });
  await chmod(temporary, 0o700);
  const temporaryIdentity = await ownedIdentity(temporary);
  const ownedFiles = [];
  const ownedDirectories = new Map();
  try {
    for (const source of sourceFiles) {
      const destination = resolve(temporary, source.path);
      if (!inside(temporary, destination, false)) throw new InstallerError('RELEASE_PATH_INVALID', 'core path escapes temporary release');
      await makeOwnedDirectory(temporary, dirname(source.path), ownedDirectories);
      const mode = source.mode === '100755' ? 0o755 : 0o644;
      await writeFile(destination, source.contents, { flag: 'wx', mode });
      await chmod(destination, mode);
      ownedFiles.push({ path: destination, identity: await ownedIdentity(destination) });
    }
    const profileDestination = resolve(temporary, PROFILE_PATH);
    if (!inside(temporary, profileDestination, false)) throw new InstallerError('RELEASE_PATH_INVALID', 'profile path escapes temporary release');
    await makeOwnedDirectory(temporary, dirname(PROFILE_PATH), ownedDirectories);
    await writeFile(profileDestination, profileContents, { flag: 'wx', mode: PROFILE_MODE });
    await chmod(profileDestination, PROFILE_MODE);
    ownedFiles.push({ path: profileDestination, identity: await ownedIdentity(profileDestination) });
    const manifestPath = join(temporary, MANIFEST_NAME);
    await writeFile(manifestPath, manifestBytes(manifest), { flag: 'wx', mode: MANIFEST_MODE });
    await chmod(manifestPath, MANIFEST_MODE);
    ownedFiles.push({ path: manifestPath, identity: await ownedIdentity(manifestPath) });
    await chmod(temporary, RELEASE_DIRECTORY_MODE);
    await assertStableDirectory(releaseRootIdentity, 'RELEASE_ROOT_IDENTITY_CHANGED', 'release-cutover');
    await rename(temporary, releaseDir);
  } catch (error) {
    await assertStableDirectory(releaseRootIdentity, 'RELEASE_ROOT_IDENTITY_CHANGED', 'release-cleanup');
    await cleanupOwnedRelease(temporary, temporaryIdentity, ownedFiles, ownedDirectories);
    throw error;
  }
}

function manifestDiagnostics(manifest) {
  const drift = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return [{ code: 'MANIFEST_INVALID', path: MANIFEST_NAME, observed: 'not an object' }];
  }
  const topLevelFields = manifest.schema_version === 1
    ? ['schema_version', 'commit', 'source_files', 'profile_sha256']
    : ['schema_version', 'commit', 'source_files', 'profile_sha256', 'runtime_surfaces'];
  if (Object.keys(manifest).length !== topLevelFields.length
    || topLevelFields.some((field) => !Object.hasOwn(manifest, field))) {
    drift.push({ code: 'MANIFEST_INVALID', path: MANIFEST_NAME, observed: 'unexpected manifest fields' });
  }
  if (![1, 2].includes(manifest.schema_version)) {
    drift.push({ code: 'MANIFEST_INVALID', path: 'schema_version', observed: manifest.schema_version });
  }
  if (typeof manifest.commit !== 'string' || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(manifest.commit)) drift.push({ code: 'MANIFEST_INVALID', path: 'commit', observed: manifest.commit });
  if (typeof manifest.profile_sha256 !== 'string' || !SHA256.test(manifest.profile_sha256)) drift.push({ code: 'MANIFEST_INVALID', path: 'profile_sha256', observed: 'invalid fingerprint' });
  if (!Array.isArray(manifest.source_files) || manifest.source_files.length === 0) {
    drift.push({ code: 'MANIFEST_INVALID', path: 'source_files', observed: manifest.source_files });
  } else {
    const seen = new Set();
    for (const entry of manifest.source_files) {
      const allowed = entry && sourceRelativePath(`${TEMPLATE_ROOT}${entry.path}`) === entry.path;
      const fields = entry && typeof entry === 'object' && !Array.isArray(entry)
        ? Object.keys(entry) : [];
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)
        || fields.length !== 3 || !['path', 'mode', 'sha256'].every((field) => Object.hasOwn(entry, field))
        || !allowed || !/^(?:100644|100755)$/.test(entry.mode)
        || !SHA256.test(entry.sha256) || seen.has(entry.path)) {
        drift.push({ code: 'MANIFEST_INVALID', path: 'source_files', observed: 'invalid closed source entry' });
      }
      seen.add(entry?.path);
    }
  }
  if (Array.isArray(manifest.source_files)) {
    const actual = manifest.source_files.map((entry) => entry?.path).sort();
    const expected = [...REQUIRED_CORE_FILES].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      drift.push({ code: 'MANIFEST_CORE_SET_MISMATCH', path: 'source_files', observed: 'incomplete or unexpected core set' });
    }
  }
  if (manifest.schema_version === 2) {
    try {
      validateRuntimeSurfaces(manifest);
    } catch (error) {
      drift.push({
        code: error.code ?? 'RUNTIME_SURFACE_INVALID',
        path: 'runtime_surfaces',
        observed: 'invalid runtime surface binding',
      });
    }
  }
  return drift;
}

async function releaseEntries(root, current = '', entries = []) {
  for (const name of (await readdir(resolve(root, current))).sort()) {
    const child = current ? `${current}/${name}` : name;
    const pathname = resolve(root, child);
    const stat = await lstat(pathname);
    if (stat.isDirectory()) {
      entries.push({ path: child, stat });
      await releaseEntries(root, child, entries);
    } else {
      entries.push({ path: child, stat });
    }
  }
  return entries;
}

export async function verifyRelease(releaseDir, { expectedManifestDigest } = {}) {
  const root = resolve(releaseDir);
  const drift = [];
  if (!SHA256.test(expectedManifestDigest ?? '')) {
    return {
      ok: false,
      drift: [{
        code: 'EXPECTED_MANIFEST_DIGEST_REQUIRED', path: 'expectedManifestDigest',
        observed: 'missing or invalid digest', expected: 'externally retained lowercase SHA-256 manifest digest',
      }],
      manifestDigest: null,
    };
  }
  try {
    await directory(root, 'RELEASE_DIRECTORY_INVALID');
  } catch (error) {
    return { ok: false, drift: [{ code: error.code ?? 'RELEASE_DIRECTORY_INVALID', path: 'release', observed: 'unavailable release directory' }], manifestDigest: null };
  }
  const releaseRootStat = await lstat(dirname(root));
  const releaseDirectoryStat = await lstat(root);
  if (exactMode(releaseRootStat) !== '0755') {
    drift.push({
      code: 'RELEASE_ROOT_MODE_MISMATCH', path: '..',
      observed: exactMode(releaseRootStat), expected: '0755',
    });
  }
  if (exactMode(releaseDirectoryStat) !== '0755') {
    drift.push({
      code: 'RELEASE_DIRECTORY_MODE_MISMATCH', path: '.',
      observed: exactMode(releaseDirectoryStat), expected: '0755',
    });
  }

  let manifest;
  let rawManifest;
  let manifestStat;
  try {
    await regularFile(join(root, MANIFEST_NAME), 'MANIFEST_INVALID');
    manifestStat = await lstat(join(root, MANIFEST_NAME));
    rawManifest = await readFile(join(root, MANIFEST_NAME));
  } catch {
    return { ok: false, drift: [{ code: 'MANIFEST_INVALID', path: MANIFEST_NAME, observed: 'unreadable manifest' }], manifestDigest: null };
  }
  const actualManifestDigest = digest(rawManifest);
  if (actualManifestDigest !== expectedManifestDigest) {
    return {
      ok: false,
      drift: [{
        code: 'MANIFEST_DIGEST_MISMATCH', path: MANIFEST_NAME,
        observed: actualManifestDigest, expected: expectedManifestDigest,
      }],
      manifestDigest: actualManifestDigest,
    };
  }
  if (exactMode(manifestStat) !== '0644') {
    drift.push({
      code: 'MANIFEST_MODE_MISMATCH', path: MANIFEST_NAME,
      observed: exactMode(manifestStat), expected: '0644',
    });
  }
  try {
    manifest = JSON.parse(rawManifest.toString('utf8'));
  } catch {
    return { ok: false, drift: [{ code: 'MANIFEST_INVALID', path: MANIFEST_NAME, observed: 'invalid JSON' }], manifestDigest: actualManifestDigest };
  }
  drift.push(...manifestDiagnostics(manifest));
  if (drift.length) return { ok: false, drift, manifestDigest: actualManifestDigest };
  if (basename(root) !== manifest.commit) {
    drift.push({ code: 'RELEASE_DIRECTORY_NAME_MISMATCH', path: root, observed: basename(root), expected: manifest.commit });
  }

  const expectedFiles = new Set([MANIFEST_NAME, PROFILE_PATH, ...manifest.source_files.map((entry) => entry.path)]);
  const expectedDirectories = new Set();
  for (const file of expectedFiles) {
    let current = dirname(file);
    while (current !== '.') {
      expectedDirectories.add(current);
      current = dirname(current);
    }
  }
  for (const entry of await releaseEntries(root)) {
    if (entry.stat.isDirectory()) {
      if (!expectedDirectories.has(entry.path)) {
        drift.push({ code: 'UNEXPECTED_RELEASE_DIRECTORY', path: entry.path });
      } else if (exactMode(entry.stat) !== '0755') {
        drift.push({
          code: 'RELEASE_DIRECTORY_MODE_MISMATCH', path: entry.path,
          observed: exactMode(entry.stat), expected: '0755',
        });
      }
      continue;
    }
    if (!expectedFiles.has(entry.path)) {
      drift.push({ code: 'UNEXPECTED_RELEASE_FILE', path: entry.path });
      continue;
    }
    if (!entry.stat.isFile() || entry.stat.isSymbolicLink()) {
      drift.push({ code: 'RELEASE_ENTRY_INVALID', path: entry.path, observed: 'not a regular file' });
    }
  }

  for (const source of manifest.source_files) {
    const pathname = resolve(root, source.path);
    if (!inside(root, pathname, false)) {
      drift.push({ code: 'MANIFEST_PATH_INVALID', path: source.path });
      continue;
    }
    try {
      await regularFile(pathname, 'SOURCE_FILE_MISSING');
      const stat = await lstat(pathname);
      const actualMode = exactMode(stat);
      const expectedMode = source.mode === '100755' ? '0755' : '0644';
      if (actualMode !== expectedMode) {
        drift.push({
          code: 'SOURCE_FILE_MODE_MISMATCH', path: source.path,
          observed: actualMode, expected: expectedMode,
        });
      }
      const actual = digest(await readFile(pathname));
      if (actual !== source.sha256) drift.push({ code: 'SOURCE_FILE_HASH_MISMATCH', path: source.path, observed: actual, expected: source.sha256 });
    } catch (error) {
      drift.push({
        code: error.code ?? 'SOURCE_FILE_MISSING', path: source.path,
        observed: 'unavailable or invalid source file',
      });
    }
  }

  try {
    await regularFile(join(root, PROFILE_PATH), 'PROFILE_MISSING');
    const profileStat = await lstat(join(root, PROFILE_PATH));
    const profileMode = exactMode(profileStat);
    if (profileMode !== '0600') {
      drift.push({ code: 'PROFILE_MODE_MISMATCH', path: PROFILE_PATH, observed: profileMode, expected: '0600' });
    }
    const actual = digest(await readFile(join(root, PROFILE_PATH)));
    if (actual !== manifest.profile_sha256) drift.push({ code: 'PROFILE_HASH_MISMATCH', path: PROFILE_PATH, observed: actual, expected: manifest.profile_sha256 });
  } catch (error) {
    drift.push({ code: 'PROFILE_MISSING', path: PROFILE_PATH, observed: 'unavailable or invalid profile file' });
  }
  return { ok: drift.length === 0, drift, manifestDigest: actualManifestDigest };
}

async function releaseManifest(releaseDir) {
  return JSON.parse(await readFile(join(releaseDir, MANIFEST_NAME), 'utf8'));
}

async function ensureRelease({
  releaseRoot, releaseDir, sourceFiles, profileContents, manifest, releaseRootIdentity,
}) {
  await assertStableDirectory(releaseRootIdentity, 'RELEASE_ROOT_IDENTITY_CHANGED', 'release-inspect');
  const expectedManifestDigest = digestManifest(manifest);
  const found = await existing(releaseDir);
  if (found) {
    if (!found.isDirectory() || found.isSymbolicLink()) {
      throw new InstallerError('RELEASE_TARGET_EXISTS', 'release location is not an immutable release directory', { releaseDir });
    }
    const verification = await verifyRelease(releaseDir, { expectedManifestDigest });
    if (!verification.ok) throw new InstallerError('RELEASE_DRIFT', 'existing release has drift and cannot be overwritten', { releaseDir, drift: verification.drift });
    if (!manifestsMatch(await releaseManifest(releaseDir), manifest)) {
      throw new InstallerError('RELEASE_IMMUTABLE_MISMATCH', 'existing release does not match requested source or profile', { releaseDir });
    }
    return;
  }
  try {
    await writeRelease(releaseRoot, releaseDir, sourceFiles, profileContents, manifest, releaseRootIdentity);
  } catch (error) {
    if (error?.code !== 'EEXIST' && error?.code !== 'ENOTEMPTY') throw error;
    const verification = await verifyRelease(releaseDir, { expectedManifestDigest });
    if (!verification.ok || !manifestsMatch(await releaseManifest(releaseDir), manifest)) {
      throw new InstallerError('RELEASE_RACE_MISMATCH', 'concurrent release creation produced a different immutable release', { releaseDir });
    }
  }
}

async function validatePathTopology({ sourceRepo, profilePath, root, backupRoot, links }) {
  const protectedPaths = {
    repo: await pathForms(sourceRepo, true),
    profile: await pathForms(profilePath, true),
    releaseRoot: await pathForms(root),
    backupRoot: backupRoot ? await pathForms(backupRoot) : null,
  };
  if (backupRoot && formsOverlap(protectedPaths.releaseRoot, protectedPaths.backupRoot)) {
    throw new InstallerError('BACKUP_PATH_INVALID', 'backupRoot must not overlap releaseRoot');
  }
  if (formsOverlap(protectedPaths.repo, protectedPaths.profile)
    || formsOverlap(protectedPaths.repo, protectedPaths.releaseRoot)
    || formsOverlap(protectedPaths.profile, protectedPaths.releaseRoot)
    || (backupRoot && (formsOverlap(protectedPaths.repo, protectedPaths.backupRoot)
      || formsOverlap(protectedPaths.profile, protectedPaths.backupRoot)))) {
    throw new InstallerError('PATH_PROTECTED_OVERLAP', 'repo, profile, releaseRoot, and backupRoot must remain disjoint');
  }
  const linkPaths = [];
  for (const [name, target] of Object.entries(links)) {
    const forms = await pathForms(target);
    if (formsOverlap(forms, protectedPaths.repo) || formsOverlap(forms, protectedPaths.profile)) {
      throw new InstallerError('PATH_PROTECTED_OVERLAP', 'runtime link must not overlap source repo or private profile', { link: name, target });
    }
    if (formsOverlap(forms, protectedPaths.releaseRoot) || (backupRoot && formsOverlap(forms, protectedPaths.backupRoot))) {
      throw new InstallerError('LINK_PATH_INVALID', 'runtime link must not overlap releaseRoot or backupRoot', { link: name, target });
    }
    linkPaths.push({ name, target, forms, canonical: forms.canonical });
  }
  for (let index = 0; index < linkPaths.length; index += 1) {
    for (let other = index + 1; other < linkPaths.length; other += 1) {
      if (formsOverlap(linkPaths[index].forms, linkPaths[other].forms)) {
        throw new InstallerError('LINK_TARGET_TOPOLOGY_INVALID', 'runtime links must be distinct non-nested paths', {
          link: linkPaths[index].name, other_link: linkPaths[other].name,
        });
      }
    }
  }
  protectedPaths.releaseRoot.anchorIdentity = await captureAncestorIdentity(
    protectedPaths.releaseRoot.canonical, 'RELEASE_ROOT_IDENTITY_CHANGED',
  );
  if (protectedPaths.backupRoot) {
    protectedPaths.backupRoot.anchorIdentity = await captureAncestorIdentity(
      protectedPaths.backupRoot.canonical, 'BACKUP_ROOT_IDENTITY_CHANGED',
    );
  }
  for (const link of linkPaths) {
    link.parentIdentity = await captureParentIdentity(link.canonical, link.name);
  }
  return { protectedPaths, linkPaths };
}

function lockPathFor(link) {
  return join(dirname(link.canonical), `.${basename(link.canonical)}.goal-condition-lock-${digest(link.canonical).slice(0, 20)}`);
}

async function acquireLocks(linkPaths, protectedPaths) {
  const locks = await Promise.all(linkPaths.map(async (link) => ({
    ...link, path: lockPathFor(link), forms: await pathForms(lockPathFor(link)), nonce: randomBytes(16).toString('hex'),
  })));
  locks.sort((left, right) => left.canonical.localeCompare(right.canonical));
  const protectedForms = Object.values(protectedPaths).filter(Boolean);
  for (const lock of locks) {
    if (protectedForms.some((forms) => formsOverlap(lock.forms, forms))
      || linkPaths.some((link) => formsOverlap(lock.forms, link.forms))) {
      throw new InstallerError('LOCK_PATH_INVALID', 'transaction lock would overlap a protected path', { link: lock.name, lock: lock.path });
    }
  }
  const acquired = [];
  try {
    for (const lock of locks) {
      const deadline = Date.now() + LOCK_TIMEOUT_MS;
      while (true) {
        try {
          await assertStableParent(lock, 'lock-acquire');
          await mkdir(lock.path, { mode: 0o700 });
          lock.identity = await ownedIdentity(lock.path);
          lock.ownerCreated = false;
          acquired.push(lock);
          await writeFile(join(lock.path, 'owner.json'), `${JSON.stringify({ pid: process.pid, nonce: lock.nonce })}\n`, { flag: 'wx', mode: 0o600 });
          lock.ownerCreated = true;
          break;
        } catch (error) {
          if (error?.code !== 'EEXIST' || Date.now() >= deadline) {
            throw new InstallerError('LINK_LOCK_UNAVAILABLE', 'runtime-link transaction lock is unavailable', { link: lock.name, lock: lock.path, cause: error });
          }
          await wait(LOCK_WAIT_MS);
        }
      }
    }
    return acquired;
  } catch (error) {
    await releaseLocks(acquired);
    throw error;
  }
}

async function releaseLocks(locks) {
  const failures = [];
  for (const lock of [...locks].reverse()) {
    try {
      await assertStableParent(lock, 'lock-cleanup');
      if (!sameIdentity(await lstat(lock.path), lock.identity)) {
        throw new InstallerError('LOCK_OWNERSHIP_LOST', 'lock ownership changed before release', { lock: lock.path });
      }
      if (lock.ownerCreated) {
        const owner = JSON.parse(await readFile(join(lock.path, 'owner.json'), 'utf8'));
        if (owner?.nonce !== lock.nonce) throw new InstallerError('LOCK_OWNERSHIP_LOST', 'lock ownership changed before release', { lock: lock.path });
        await unlink(join(lock.path, 'owner.json'));
      }
      await rmdir(lock.path);
    } catch (error) {
      failures.push({ lock: lock.path, code: error.code, message: error.message });
    }
  }
  if (failures.length) throw new InstallerError('LOCK_RELEASE_FAILED', 'could not safely remove owned transaction locks', { failures });
}

async function ensureLinkParent(link, phase) {
  await assertStableParent(link, phase);
  await directory(link.parentIdentity.path, 'LINK_PARENT_INVALID', { link: link.name });
}

async function inspectLinkTargets(links, backupRoot) {
  for (const link of links) {
    await ensureLinkParent(link, 'inspect');
    const stat = await existing(link.canonical);
    if (stat && !stat.isSymbolicLink() && !backupRoot) {
      throw new InstallerError('LINK_TARGET_EXISTS', 'ordinary link target requires explicit backupRoot', { link: link.name });
    }
  }
}

async function backupTarget(link, backupRoot, backupRootIdentity, index) {
  await assertStableParent(link, 'backup');
  await assertStableDirectory(backupRootIdentity, 'BACKUP_ROOT_IDENTITY_CHANGED', 'backup');
  const backup = join(backupRoot, `${link.name}-${process.pid}-${index}`);
  if (await existing(backup)) throw new InstallerError('BACKUP_TARGET_EXISTS', 'backup location already exists', { link: link.name });
  await rename(link.canonical, backup);
  return { link: link.name, target: link.canonical, backup };
}

function temporaryLinkPath(target, nonce) {
  return join(dirname(target), `.${basename(target)}.${process.pid}-${nonce}-${randomBytes(6).toString('hex')}.link`);
}

async function stageLink(link, releaseDir, nonce) {
  await assertStableParent(link, 'stage');
  const temporary = temporaryLinkPath(link.canonical, nonce);
  let identity;
  try {
    await symlink(releaseDir, temporary, 'dir');
    identity = await symlinkIdentity(temporary, releaseDir);
    if (!identity) throw new InstallerError('LINK_OWNERSHIP_LOST', 'staged symlink identity could not be verified', { link: link.name });
  } catch (error) {
    await cleanupOwnedSymlink(temporary, identity, link);
    if (error instanceof InstallerError && error.code === 'LINK_PARENT_IDENTITY_CHANGED') throw error;
    throw new InstallerError('LINK_STAGING_FAILED', 'could not stage atomic runtime switch', { link: link.name, cause: error });
  }
  return { ...link, target: link.canonical, temporary, temporaryIdentity: identity };
}

async function stageLinks(links, releaseDir, nonce) {
  const staged = [];
  try {
    for (const link of links) staged.push(await stageLink(link, releaseDir, nonce));
    return staged;
  } catch (error) {
    await Promise.all(staged.map((link) => cleanupOwnedSymlink(link.temporary, link.temporaryIdentity, link)));
    throw error;
  }
}

async function switchLink(link) {
  await assertStableParent(link, 'cutover');
  try {
    await rename(link.temporary, link.target);
  } catch (error) {
    throw new InstallerError('LINK_SWITCH_FAILED', 'could not atomically switch runtime link', { link: link.name, cause: error });
  }
}

async function symlinkIdentity(target, expectedTarget) {
  const stat = await lstat(target);
  if (!stat.isSymbolicLink() || await readlink(target) !== expectedTarget) return null;
  return { dev: stat.dev, ino: stat.ino, target: expectedTarget };
}

async function ownedByTransaction(target, identity) {
  if (!identity) return false;
  const current = await symlinkIdentity(target, identity.target);
  return current !== null && current.dev === identity.dev && current.ino === identity.ino;
}

async function cleanupOwnedSymlink(pathname, identity, link) {
  try {
    if (link) await assertStableParent(link, 'cleanup');
    if (await ownedByTransaction(pathname, identity)) await unlink(pathname);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function restoreLink(original) {
  await assertStableParent(original, 'rollback');
  const targetExists = await existing(original.target);
  if (original.installedIdentity && !await ownedByTransaction(original.target, original.installedIdentity)) {
    throw new InstallerError('LINK_OWNERSHIP_LOST', 'transaction will not overwrite a link it no longer owns', { link: original.name, target: original.target });
  }
  if (original.kind === 'backup') {
    await assertStableDirectory(original.backupRootIdentity, 'BACKUP_ROOT_IDENTITY_CHANGED', 'rollback');
    if (original.installedIdentity) await unlink(original.target);
    else if (targetExists) throw new InstallerError('LINK_OWNERSHIP_LOST', 'backup restore target changed before rollback', { link: original.name });
    await rename(original.backup, original.target);
    return;
  }
  if (original.kind === 'missing') {
    if (original.installedIdentity) await unlink(original.target);
    else if (targetExists) throw new InstallerError('LINK_OWNERSHIP_LOST', 'missing target appeared before rollback', { link: original.name });
    return;
  }
  if (!original.installedIdentity) {
    if (!targetExists || await readlink(original.target) !== original.value) {
      throw new InstallerError('LINK_OWNERSHIP_LOST', 'original symlink changed before rollback', { link: original.name });
    }
    return;
  }
  const temporary = temporaryLinkPath(original.target, original.nonce);
  let temporaryIdentity;
  try {
    await symlink(original.value, temporary, 'dir');
    temporaryIdentity = await symlinkIdentity(temporary, original.value);
    if (!temporaryIdentity) throw new InstallerError('LINK_OWNERSHIP_LOST', 'rollback symlink identity could not be verified', { link: original.name });
    await rename(temporary, original.target);
  } finally {
    await cleanupOwnedSymlink(temporary, temporaryIdentity, original);
  }
}

async function switchLinks(
  links, releaseDir, backupRoot, backupAnchorIdentity, nonce, verifyReleaseIntegrity,
) {
  const backups = [];
  let backupRootIdentity;
  if (backupRoot) {
    await assertStableDirectory(backupAnchorIdentity, 'BACKUP_ROOT_IDENTITY_CHANGED', 'backup-root-create');
    await mkdir(backupRoot, { recursive: true });
    await assertStableDirectory(backupAnchorIdentity, 'BACKUP_ROOT_IDENTITY_CHANGED', 'backup-root-created');
    await directory(backupRoot, 'BACKUP_ROOT_INVALID');
    backupRootIdentity = await captureDirectoryIdentity(backupRoot, 'BACKUP_ROOT_IDENTITY_CHANGED');
  }
  await verifyReleaseIntegrity('link-stage');
  const staged = await stageLinks(links, releaseDir, nonce);
  const originals = [];
  try {
    for (const stagedLink of staged) {
      const stat = await existing(stagedLink.target);
      if (!stat) {
        originals.push({ ...stagedLink, kind: 'missing' });
      } else if (stat.isSymbolicLink()) {
        originals.push({ ...stagedLink, kind: 'symlink', value: await readlink(stagedLink.target) });
      } else {
        const backup = await backupTarget(stagedLink, backupRoot, backupRootIdentity, backups.length);
        backups.push(backup);
        originals.push({
          ...stagedLink, kind: 'backup', backup: backup.backup, backupRootIdentity,
        });
      }
      await switchLink(stagedLink);
      const original = originals.at(-1);
      original.nonce = nonce;
      original.installedIdentity = await symlinkIdentity(stagedLink.target, releaseDir);
      if (!original.installedIdentity) throw new InstallerError('LINK_OWNERSHIP_LOST', 'atomic switch did not create the owned expected symlink', { link: stagedLink.name });
    }
    const expected = await realpath(releaseDir);
    for (const link of links) {
      await assertStableParent(link, 'readback');
      if (await realpath(link.canonical) !== expected) {
        throw new InstallerError('LINK_TARGET_MISMATCH', 'runtime link did not resolve to the immutable release', { link: link.name });
      }
    }
    await verifyReleaseIntegrity('link-readback');
  } catch (error) {
    const rollbackErrors = [];
    for (const original of originals.reverse()) {
      try {
        await restoreLink(original);
      } catch (rollbackError) {
        rollbackErrors.push({ link: original.name, code: rollbackError.code, message: rollbackError.message });
      }
    }
    if (rollbackErrors.length) {
      throw new InstallerError('LINK_ROLLBACK_FAILED', 'runtime link switch failed and rollback was incomplete', {
        cause: error, rollbackErrors, backups,
      });
    }
    error.backups = backups;
    throw error;
  } finally {
    await Promise.all(staged.map((link) => cleanupOwnedSymlink(link.temporary, link.temporaryIdentity, link)));
  }
  return backups;
}

function validateFaultInjector(faultInjector) {
  if (faultInjector !== undefined && typeof faultInjector !== 'function') {
    throw new InstallerError('INSTALL_ARGUMENT_INVALID', 'faultInjector must be a function when supplied', { field: 'faultInjector' });
  }
}

function validateStageArguments({ repo, ref, profile, releaseRoot }) {
  for (const [field, value] of Object.entries({ repo, ref, profile, releaseRoot })) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new InstallerError('INSTALL_ARGUMENT_INVALID', `${field} must be a non-empty path or ref`, { field });
    }
  }
}

function validateActivateArguments({ releaseDir, expectedManifestDigest, links, backupRoot }) {
  if (typeof releaseDir !== 'string' || releaseDir.length === 0) {
    throw new InstallerError('INSTALL_ARGUMENT_INVALID', 'releaseDir must be a non-empty path', { field: 'releaseDir' });
  }
  if (!SHA256.test(expectedManifestDigest ?? '')) {
    throw new InstallerError(
      'INSTALL_ARGUMENT_INVALID',
      'expectedManifestDigest must be a lowercase SHA-256 digest',
      { field: 'expectedManifestDigest' },
    );
  }
  if (links === null || typeof links !== 'object' || Array.isArray(links) || Object.keys(links).length === 0) {
    throw new InstallerError('INSTALL_ARGUMENT_INVALID', 'links must map runtime names to paths', { field: 'links' });
  }
  for (const [name, target] of Object.entries(links)) {
    if (!/^[A-Za-z0-9_-]+$/.test(name) || typeof target !== 'string' || target.length === 0) {
      throw new InstallerError('INSTALL_ARGUMENT_INVALID', 'each link needs a safe name and non-empty path', { field: 'links', link: name });
    }
  }
  if (backupRoot !== undefined && (typeof backupRoot !== 'string' || backupRoot.length === 0)) {
    throw new InstallerError('INSTALL_ARGUMENT_INVALID', 'backupRoot must be a non-empty path when supplied', { field: 'backupRoot' });
  }
}

async function validateStagePathTopology({ sourceRepo, profilePath, root }) {
  const protectedPaths = {
    repo: await pathForms(sourceRepo, true),
    profile: await pathForms(profilePath, true),
    releaseRoot: await pathForms(root),
  };
  if (formsOverlap(protectedPaths.repo, protectedPaths.profile)
    || formsOverlap(protectedPaths.repo, protectedPaths.releaseRoot)
    || formsOverlap(protectedPaths.profile, protectedPaths.releaseRoot)) {
    throw new InstallerError('PATH_PROTECTED_OVERLAP', 'repo, profile, and releaseRoot must remain disjoint');
  }
  protectedPaths.releaseRoot.anchorIdentity = await captureAncestorIdentity(
    protectedPaths.releaseRoot.canonical, 'RELEASE_ROOT_IDENTITY_CHANGED',
  );
  return protectedPaths;
}

async function validateActivationPathTopology({ releaseDir, backupRoot, links }) {
  const release = await pathForms(releaseDir, true);
  const releaseRoot = await pathForms(dirname(release.canonical), true);
  const backup = backupRoot ? await pathForms(backupRoot) : null;
  if (backup && (formsOverlap(release, backup) || formsOverlap(releaseRoot, backup))) {
    throw new InstallerError('BACKUP_PATH_INVALID', 'backupRoot must not overlap the immutable release');
  }
  const linkPaths = [];
  for (const [name, target] of Object.entries(links)) {
    const forms = await pathForms(target);
    if (formsOverlap(forms, release) || formsOverlap(forms, releaseRoot)
      || (backup && formsOverlap(forms, backup))) {
      throw new InstallerError('LINK_PATH_INVALID', 'runtime link must not overlap releaseRoot or backupRoot', {
        link: name, target,
      });
    }
    linkPaths.push({ name, target, forms, canonical: forms.canonical });
  }
  for (let index = 0; index < linkPaths.length; index += 1) {
    for (let other = index + 1; other < linkPaths.length; other += 1) {
      if (formsOverlap(linkPaths[index].forms, linkPaths[other].forms)) {
        throw new InstallerError('LINK_TARGET_TOPOLOGY_INVALID', 'runtime links must be distinct non-nested paths', {
          link: linkPaths[index].name, other_link: linkPaths[other].name,
        });
      }
    }
  }
  if (backup) {
    backup.anchorIdentity = await captureAncestorIdentity(
      backup.canonical, 'BACKUP_ROOT_IDENTITY_CHANGED',
    );
  }
  for (const link of linkPaths) link.parentIdentity = await captureParentIdentity(link.canonical, link.name);
  return { release, releaseRoot, backup, linkPaths };
}

export async function stageRelease(
  { repo, ref, profile, releaseRoot } = {},
  { faultInjector } = {},
) {
  validateStageArguments({ repo, ref, profile, releaseRoot });
  validateFaultInjector(faultInjector);
  const sourceRepo = resolve(repo);
  const profilePath = resolve(profile);
  const requestedRoot = resolve(releaseRoot);
  await directory(sourceRepo, 'REPOSITORY_INVALID', { field: 'repo' });
  await regularFile(profilePath, 'PROFILE_INVALID', { field: 'profile' });
  const capturedProfile = await captureProfile(profilePath);
  let primaryError;
  try {
    const commit = await resolveCommit(sourceRepo, ref);
    const sourceFiles = await readCoreFiles(sourceRepo, commit);
    const manifest = manifestFor(commit, sourceFiles, digest(capturedProfile.contents));
    const manifestDigest = digestManifest(manifest);
    const topology = await validateStagePathTopology({ sourceRepo, profilePath, root: requestedRoot });
    await assertStableDirectory(
      topology.releaseRoot.anchorIdentity, 'RELEASE_ROOT_IDENTITY_CHANGED', 'stage-prepare',
    );
    const root = topology.releaseRoot.canonical;
    await mkdir(root, { recursive: true, mode: RELEASE_DIRECTORY_MODE });
    await assertStableDirectory(
      topology.releaseRoot.anchorIdentity, 'RELEASE_ROOT_IDENTITY_CHANGED', 'stage-root-created',
    );
    await directory(root, 'RELEASE_ROOT_INVALID', { field: 'releaseRoot' });
    await chmod(root, RELEASE_DIRECTORY_MODE);
    const releaseRootIdentity = await captureDirectoryIdentity(root, 'RELEASE_ROOT_IDENTITY_CHANGED');
    const releaseDir = join(root, commit);
    await ensureRelease({
      releaseRoot: root,
      releaseDir,
      sourceFiles,
      profileContents: capturedProfile.contents,
      manifest,
      releaseRootIdentity,
    });
    if (faultInjector) await faultInjector('after_release');
    return {
      commit,
      releaseDir,
      manifest,
      manifestDigest,
      runtimeSurfaces: manifest.runtime_surfaces,
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await capturedProfile.handle.close();
    } catch (cleanupError) {
      if (primaryError) primaryError.cleanupFailure = cleanupError.code ?? 'PROFILE_CLOSE_FAILED';
      else throw cleanupError;
    }
  }
}

export async function activateRelease(
  { releaseDir, expectedManifestDigest, links, backupRoot } = {},
  { faultInjector } = {},
) {
  validateActivateArguments({ releaseDir, expectedManifestDigest, links, backupRoot });
  validateFaultInjector(faultInjector);
  const requestedRelease = resolve(releaseDir);
  const normalizedLinks = Object.fromEntries(Object.entries(links).map(([name, target]) => [name, resolve(target)]));
  const normalizedBackup = backupRoot === undefined ? undefined : resolve(backupRoot);
  const initialVerification = await verifyRelease(requestedRelease, { expectedManifestDigest });
  if (!initialVerification.ok) {
    throw new InstallerError('RELEASE_DRIFT', 'staged release failed external-digest verification before activation', {
      drift: initialVerification.drift,
    });
  }
  const topology = await validateActivationPathTopology({
    releaseDir: requestedRelease,
    backupRoot: normalizedBackup,
    links: normalizedLinks,
  });
  const locks = await acquireLocks(topology.linkPaths, {
    releaseRoot: topology.releaseRoot,
    backupRoot: topology.backup,
  });
  const nonce = locks.map((lock) => lock.nonce).join('-');
  let primaryError;
  try {
    if (faultInjector) await faultInjector('after_locks');
    if (topology.backup) {
      await assertStableDirectory(
        topology.backup.anchorIdentity, 'BACKUP_ROOT_IDENTITY_CHANGED', 'activate-prepare',
      );
    }
    await inspectLinkTargets(topology.linkPaths, normalizedBackup);
    const canonicalRelease = topology.release.canonical;
    const releaseRootIdentity = await captureDirectoryIdentity(
      topology.releaseRoot.canonical, 'RELEASE_ROOT_IDENTITY_CHANGED',
    );
    const releaseIdentity = await captureDirectoryIdentity(canonicalRelease, 'RELEASE_IDENTITY_CHANGED');
    const verifyReleaseIntegrity = async (phase) => {
      await assertStableDirectory(releaseRootIdentity, 'RELEASE_ROOT_IDENTITY_CHANGED', phase);
      await assertStableDirectory(releaseIdentity, 'RELEASE_IDENTITY_CHANGED', phase);
      const verification = await verifyRelease(canonicalRelease, { expectedManifestDigest });
      if (!verification.ok) {
        throw new InstallerError('RELEASE_DRIFT', 'release failed external-digest verification before runtime switch', {
          drift: verification.drift,
        });
      }
    };
    const backups = await switchLinks(
      topology.linkPaths,
      canonicalRelease,
      topology.backup?.canonical,
      topology.backup?.anchorIdentity,
      nonce,
      verifyReleaseIntegrity,
    );
    return { releaseDir: canonicalRelease, manifestDigest: expectedManifestDigest, backups };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await releaseLocks(locks);
    } catch (cleanupError) {
      if (primaryError) primaryError.cleanupFailure = cleanupError.code ?? 'LOCK_RELEASE_FAILED';
      else throw cleanupError;
    }
  }
}

export async function installRelease(
  { repo, ref, profile, releaseRoot, links, backupRoot } = {},
  { faultInjector } = {},
) {
  validateArguments({ repo, ref, profile, releaseRoot, links, backupRoot });
  validateFaultInjector(faultInjector);
  const sourceRepo = resolve(repo);
  const profilePath = resolve(profile);
  const requestedRoot = resolve(releaseRoot);
  const normalizedLinks = Object.fromEntries(Object.entries(links).map(([name, target]) => [name, resolve(target)]));
  const normalizedBackup = backupRoot === undefined ? undefined : resolve(backupRoot);
  await directory(sourceRepo, 'REPOSITORY_INVALID', { field: 'repo' });
  await regularFile(profilePath, 'PROFILE_INVALID', { field: 'profile' });
  const preflight = await validatePathTopology({
    sourceRepo,
    profilePath,
    root: requestedRoot,
    backupRoot: normalizedBackup,
    links: normalizedLinks,
  });
  await inspectLinkTargets(preflight.linkPaths, normalizedBackup);
  const staged = await stageRelease(
    { repo, ref, profile, releaseRoot },
    { faultInjector },
  );
  const activated = await activateRelease({
    releaseDir: staged.releaseDir,
    expectedManifestDigest: staged.manifestDigest,
    links,
    backupRoot,
  }, { faultInjector });
  return { ...staged, backups: activated.backups };
}
