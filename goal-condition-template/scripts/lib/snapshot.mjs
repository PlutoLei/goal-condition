import { createHash } from 'node:crypto';
import { execFile as execFileCallback, spawn } from 'node:child_process';
import { lstat, readlink, readdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { contractHash, validateContract } from './contract.mjs';

const execFile = promisify(execFileCallback);
const GLOB_META = /[*?[\]{}]/;
const TEMPORARY_PATH = /^(?:\/private)?\/tmp(?:\/|$)|^(?:\/private)?\/var\/folders(?:\/|$)/;

export class SnapshotError extends Error {
  constructor(diagnostics) {
    super('Snapshot preflight failed');
    this.name = 'SnapshotError';
    this.diagnostics = diagnostics;
  }
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fileMode(stat) {
  return (stat.mode & 0o7777).toString(8).padStart(4, '0');
}

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableJson(value[key])]));
  }
  return value;
}

export function snapshotDigest(snapshot) {
  return digest(`${JSON.stringify(stableJson(snapshot))}\n`);
}

function diagnostic(code, entry, field, observed, expected, next) {
  return { code, entry, field, observed: String(observed), expected, next };
}

function snapshotError(diagnostics) {
  throw new SnapshotError(diagnostics);
}

function contractDiagnostics(contract) {
  return validateContract(contract).map((item) => diagnostic(
    item.code,
    'contract',
    item.path || 'contract',
    item.observed,
    item.expected,
    item.next,
  ));
}

function validateTargetRoot(contract) {
  const roots = contract?.target_roots;
  if (!Array.isArray(roots) || roots.length !== 1) {
    snapshotError([diagnostic(
      'TARGET_ROOT_COUNT_INVALID', 'contract', 'target_roots', JSON.stringify(roots),
      'exactly one target root', 'declare one isolated target root before capturing a snapshot',
    )]);
  }
  return resolve(roots[0]);
}

function isInsideRoot(root, candidate, allowRoot = true) {
  const pathRelative = relative(root, resolve(candidate));
  return (allowRoot || pathRelative.length > 0)
    && pathRelative !== '..'
    && !pathRelative.startsWith(`..${sep}`)
    && !pathRelative.startsWith(sep);
}

function rootEscapeDiagnostic(entry, field, observed, root) {
  return diagnostic(
    'TARGET_ROOT_ESCAPE', entry, field, observed, `path contained by declared target root ${root}`,
    'move the entry or authorization path inside the sole declared target root',
  );
}

async function assertNoEscapingSymlink(root, candidate, entry, field) {
  const target = resolve(candidate);
  if (!isInsideRoot(root, target)) snapshotError([rootEscapeDiagnostic(entry, field, candidate, root)]);
  const pathRelative = relative(root, target);
  if (pathRelative.length === 0) return;
  let cursor = root;
  for (const part of pathRelative.split(sep)) {
    cursor = resolve(cursor, part);
    let stat;
    try {
      stat = await lstat(cursor);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    if (!stat.isSymbolicLink()) continue;
    let physical;
    try {
      physical = await realpath(cursor);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      physical = resolve(resolve(cursor, '..'), await readlink(cursor));
    }
    if (!isInsideRoot(root, physical)) {
      snapshotError([diagnostic(
        'SYMLINK_ESCAPES_TARGET_ROOT', entry, field, cursor, `symlink resolving within declared target root ${root}`,
        'replace the escaping symlink with an in-root path before capturing the snapshot',
      )]);
    }
  }
}

async function assertNoEscapingSymlinksBelow(root, pathname, entry, field) {
  await assertNoEscapingSymlink(root, pathname, entry, field);
  let stat;
  try {
    stat = await lstat(pathname);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return;
  for (const name of (await readdir(pathname)).sort()) {
    await assertNoEscapingSymlinksBelow(root, resolve(pathname, name), entry, field);
  }
}

async function validateSnapshotBoundary(contract, root) {
  let rootStat;
  try {
    rootStat = await lstat(root);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      snapshotError([diagnostic(
        'TARGET_ROOT_REQUIRED', 'contract', 'target_roots[0]', root, 'existing directory target root',
        'create the declared target root or correct the contract path',
      )]);
    }
    throw error;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    snapshotError([diagnostic(
      'TARGET_ROOT_INVALID', 'contract', 'target_roots[0]', root, 'non-symlink directory target root',
      'declare a physical directory as the sole target root',
    )]);
  }

  const escapes = [];
  for (const entry of contract.preflight) {
    const field = entry.type === 'command' ? 'cwd' : 'target';
    const candidate = entry[field];
    if (!isInsideRoot(root, candidate)) escapes.push(rootEscapeDiagnostic(entry.id, field, candidate, root));
  }
  for (const context of contract.context_sources) {
    if (!isInsideRoot(root, context.path)) escapes.push(rootEscapeDiagnostic(context.id, 'path', context.path, root));
  }
  for (const [index, pattern] of contract.allowed_mutations.files.entries()) {
    const prefix = pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern;
    if (!isInsideRoot(root, prefix)) escapes.push(rootEscapeDiagnostic('contract', `allowed_mutations.files[${index}]`, pattern, root));
  }
  if (escapes.length) snapshotError(escapes);

  for (const entry of contract.preflight) {
    await assertNoEscapingSymlink(root, entry.type === 'command' ? entry.cwd : entry.target, entry.id, entry.type === 'command' ? 'cwd' : 'target');
  }
  for (const context of contract.context_sources) {
    await assertNoEscapingSymlink(root, context.path, context.id, 'path');
  }
  for (const [index, pattern] of contract.allowed_mutations.files.entries()) {
    const pathname = pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern;
    if (pattern.endsWith('/**')) {
      await assertNoEscapingSymlinksBelow(root, pathname, 'contract', `allowed_mutations.files[${index}]`);
    } else {
      await assertNoEscapingSymlink(root, pathname, 'contract', `allowed_mutations.files[${index}]`);
    }
  }
}

async function captureContexts(contract, root) {
  const physicalRoot = await realpath(root);
  if (TEMPORARY_PATH.test(physicalRoot)) {
    snapshotError([diagnostic(
      'TARGET_ROOT_TEMPORARY_PHYSICAL_PATH', 'contract', 'target_roots[0]', 'temporary physical path',
      'stable non-temporary physical target root',
      'move the target root outside temporary storage and recapture the baseline',
    )]);
  }
  const contexts = [];
  for (const source of contract.context_sources) {
    let stat;
    try {
      stat = await lstat(source.path);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        snapshotError([diagnostic(
          'CONTEXT_FILE_INVALID', source.id, 'path', 'missing', 'existing regular non-symlink file',
          'create the stable context file or correct the content-bound contract entry',
        )]);
      }
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      snapshotError([diagnostic(
        'CONTEXT_FILE_INVALID', source.id, 'path', 'non-regular or symlink entry',
        'regular non-symlink file', 'replace the context source with a stable regular file',
      )]);
    }
    const physical = await realpath(source.path);
    if (!isInsideRoot(physicalRoot, physical)) {
      snapshotError([diagnostic(
        'CONTEXT_ROOT_ESCAPE', source.id, 'path', 'physical path outside target root',
        'physical context path inside the declared root',
        'move the context into the declared root without an escaping alias',
      )]);
    }
    if (TEMPORARY_PATH.test(physical)) {
      snapshotError([diagnostic(
        'CONTEXT_TEMPORARY_PHYSICAL_PATH', source.id, 'path', 'temporary physical path',
        'stable non-temporary physical context path',
        'move the context bytes outside temporary storage and update the contract binding',
      )]);
    }
    const bytesSha256 = digest(await readFile(source.path));
    if (bytesSha256 !== source.sha256) {
      snapshotError([diagnostic(
        'CONTEXT_HASH_MISMATCH', source.id, 'sha256', bytesSha256, source.sha256,
        'restore the confirmed context bytes or regenerate, preview, and reconfirm the contract',
      )]);
    }
    contexts.push({ id: source.id, path: source.path, sha256: bytesSha256, mode: fileMode(stat) });
  }
  return contexts;
}

function validateAllowedFilePatterns(contract) {
  const diagnostics = [];
  const patterns = contract?.allowed_mutations?.files;
  if (!Array.isArray(patterns)) return diagnostics;
  patterns.forEach((pattern, index) => {
    const field = `allowed_mutations.files[${index}]`;
    if (typeof pattern !== 'string' || !isAbsolute(pattern)) {
      diagnostics.push(diagnostic(
        'FILE_PATTERN_INVALID', 'contract', field, pattern,
        'absolute exact path or directory prefix ending /**',
        'supply an absolute path without glob metacharacters',
      ));
      return;
    }
    const prefix = pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern;
    if (GLOB_META.test(prefix)) {
      diagnostics.push(diagnostic(
        'FILE_PATTERN_INVALID', 'contract', field, pattern,
        'absolute exact path or directory prefix ending /**',
        'replace the unsupported glob with an exact path or a directory /** prefix',
      ));
    }
  });
  return diagnostics;
}

async function runGit(target, args) {
  return execFile('git', ['-C', target, ...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
}

async function runGitMaterial(target, args) {
  return runGit(target, ['--no-replace-objects', ...args]);
}

function hashGitBlob(target, object, objectFormat, expectedSize) {
  return new Promise((resolveHash, rejectHash) => {
    const child = spawn('git', ['-C', target, '--no-replace-objects', 'cat-file', 'blob', object], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const bytesHash = createHash('sha256');
    const objectHash = createHash(objectFormat);
    objectHash.update(Buffer.from(`blob ${expectedSize}\0`));
    let bytesRead = 0;
    child.stdout.on('data', (chunk) => {
      bytesRead += chunk.length;
      bytesHash.update(chunk);
      objectHash.update(chunk);
    });
    child.stderr.resume();
    child.once('error', rejectHash);
    child.once('close', (code) => {
      if (code !== 0) {
        rejectHash(Object.assign(new Error('Git blob read failed'), { code }));
        return;
      }
      resolveHash({
        bytesRead,
        bytesSha256: bytesHash.digest('hex'),
        computedObject: objectHash.digest('hex'),
      });
    });
  });
}

async function gitOutputOrNull(target, args) {
  try {
    return (await runGit(target, args)).stdout.trim() || null;
  } catch {
    return null;
  }
}

async function gitMaterialOutputOrNull(target, args) {
  try {
    return (await runGitMaterial(target, args)).stdout.trim() || null;
  } catch {
    return null;
  }
}

function parsePorcelain(stdout) {
  const fields = stdout.split('\0');
  const entries = [];
  for (let index = 0; index < fields.length - 1; index += 1) {
    const value = fields[index];
    if (!value) continue;
    const code = value.slice(0, 2);
    const path = value.slice(3);
    const entry = { code, path };
    if (code.includes('R') || code.includes('C')) {
      entry.original_path = fields[index + 1] ?? '';
      index += 1;
    }
    entries.push(entry);
  }
  return entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

function parseTree(stdout, entryId) {
  return stdout.split('\0').filter(Boolean).map((line) => {
    const tab = line.indexOf('\t');
    const [mode, type, object, sizeText] = line.slice(0, tab).trim().split(/\s+/);
    const size = type === 'blob' ? Number(sizeText) : null;
    if (tab < 0 || !/^(?:100644|100755|120000|160000)$/.test(mode ?? '')
      || !['blob', 'commit'].includes(type) || !/^[0-9a-f]{40,64}$/.test(object ?? '')
      || (type === 'blob' && (!Number.isSafeInteger(size) || size < 0))
      || (type === 'commit' && sizeText !== '-')) {
      snapshotError([diagnostic(
        'GIT_TREE_INVALID', entryId, 'tree', 'malformed ls-tree record',
        'mode, type, object id, expected blob size, and safe relative path',
        'repair the repository tree before capturing a snapshot',
      )]);
    }
    return { mode, type, object, size, path: line.slice(tab + 1) };
  }).sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

async function captureTreeMaterial(target, stdout, entryId, objectFormat) {
  const entries = parseTree(stdout, entryId);
  const captured = [];
  for (const item of entries) {
    if (!safeGitRelativePath(item.path)) {
      snapshotError([diagnostic(
        'GIT_PATH_INVALID', entryId, 'tree.path', item.path, 'safe relative Git path',
        'rename or remove the invalid Git path; a snapshot cannot represent it, so declaring it in allowed_mutations will not help',
      )]);
    }
    if (item.type === 'blob') {
      let material;
      try {
        material = await hashGitBlob(target, item.object, objectFormat, item.size);
      } catch (error) {
        snapshotError([diagnostic(
          'GIT_TREE_MATERIAL_FAILED', entryId, 'tree', `git exit ${error?.code ?? 'unknown'}`,
          'readable committed Git blob material',
          'repair the repository object database and retry snapshot capture',
        )]);
      }
      if (material.bytesRead !== item.size) {
        snapshotError([diagnostic(
          'GIT_BLOB_SIZE_MISMATCH', entryId, 'tree.size', material.bytesRead, String(item.size),
          'restore the Git object whose streamed bytes match its declared blob size',
        )]);
      }
      if (material.computedObject !== item.object) {
        snapshotError([diagnostic(
          'GIT_BLOB_OBJECT_MISMATCH', entryId, 'tree.object',
          `${objectFormat}:${material.computedObject}`, `${objectFormat}:${item.object}`,
          'restore the Git object database from a trusted source before recapturing the snapshot',
        )]);
      }
      const treeEntry = { ...item };
      delete treeEntry.size;
      captured.push({ ...treeEntry, bytes_sha256: material.bytesSha256 });
    } else {
      const treeEntry = { ...item };
      delete treeEntry.size;
      captured.push(treeEntry);
    }
  }
  return captured;
}

async function captureEffectiveTree(target, states, treeEntries, entryId) {
  const projected = new Map();
  const baselineTree = new Map(treeEntries.map((item) => [item.path, item]));

  async function visit(state) {
    if (projected.has(state.path)) return;
    if (baselineTree.get(state.path)?.type === 'commit') {
      const gitlink = baselineTree.get(state.path);
      projected.set(state.path, {
        path: state.path, type: 'gitlink', mode: gitlink.mode, object: gitlink.object,
      });
      return;
    }
    if (state.type === 'directory') {
      projected.set(state.path, { path: state.path, type: 'missing' });
      for (const child of state.entries) await visit(child);
      return;
    }
    if (state.type === 'missing') {
      projected.set(state.path, { path: state.path, type: 'missing' });
      return;
    }
    if (state.type === 'symlink') {
      projected.set(state.path, {
        path: state.path, type: 'symlink', mode: '120000', bytes_sha256: digest(Buffer.from(state.target)),
      });
      return;
    }
    if (state.type === 'file') {
      let object;
      try {
        object = (await runGitMaterial(target, [
          'hash-object', `--path=${state.path}`, '--', resolve(target, state.path),
        ])).stdout.trim();
      } catch (error) {
        snapshotError([diagnostic(
          'GIT_EFFECTIVE_MATERIAL_FAILED', entryId, 'effective_tree', `git exit ${error?.code ?? 'unknown'}`,
          'argv-only Git clean-filter projection of baseline effective file material',
          'repair the path-specific Git attributes/filter configuration and retry capture',
        )]);
      }
      if (!/^[0-9a-f]{40,64}$/.test(object)) {
        snapshotError([diagnostic(
          'GIT_EFFECTIVE_MATERIAL_FAILED', entryId, 'effective_tree', 'invalid Git object hash',
          'Git object hash for baseline effective file material',
          'repair the repository object format or Git configuration and retry capture',
        )]);
      }
      projected.set(state.path, {
        path: state.path, type: 'file', mode: state.mode, object,
      });
      return;
    }
    projected.set(state.path, { path: state.path, type: state.type, mode: state.mode });
  }

  for (const state of states) await visit(state);
  return [...projected.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function parseIndex(stdout) {
  return stdout.split('\0').filter(Boolean).map((record) => {
    const tab = record.indexOf('\t');
    const [mode, object, stage] = record.slice(0, tab).split(' ');
    return { mode, object, stage: Number(stage), path: record.slice(tab + 1) };
  }).sort((left, right) => left.path.localeCompare(right.path) || left.stage - right.stage);
}

function parseRefs(stdout) {
  const refs = {};
  for (const line of stdout.split('\n').filter(Boolean).sort()) {
    const separator = line.indexOf(' ');
    if (separator <= 0) continue;
    refs[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return refs;
}

async function capturePathState(pathname, relativePath = '', boundary = undefined) {
  let stat;
  try {
    stat = await lstat(pathname);
  } catch (error) {
    if (error?.code === 'ENOENT') return { path: relativePath, type: 'missing' };
    throw error;
  }
  if (stat.isSymbolicLink()) {
    if (boundary) await assertNoEscapingSymlink(boundary.root, pathname, boundary.entry, boundary.field);
    return { path: relativePath, type: 'symlink', mode: fileMode(stat), target: await readlink(pathname) };
  }
  if (stat.isFile()) {
    return { path: relativePath, type: 'file', mode: fileMode(stat), bytes_sha256: digest(await readFile(pathname)) };
  }
  if (!stat.isDirectory()) return { path: relativePath, type: 'other', mode: fileMode(stat) };

  const names = (await readdir(pathname))
    .filter((name) => !(boundary?.skipRootGitMetadata && relativePath === '' && name === '.git'))
    .sort();
  const entries = [];
  for (const name of names) {
    entries.push(await capturePathState(resolve(pathname, name), relativePath ? `${relativePath}/${name}` : name, boundary));
  }
  return { path: relativePath, type: 'directory', mode: fileMode(stat), entries };
}

function safeGitRelativePath(pathname) {
  return typeof pathname === 'string' && pathname.length > 0 && !pathname.includes('\0')
    && !pathname.split('/').includes('..') && !pathname.startsWith('/');
}

async function proveGitAncestry(entry, baselineHead, currentHead) {
  try {
    await runGitMaterial(entry.target, ['merge-base', '--is-ancestor', baselineHead, currentHead]);
    return true;
  } catch (error) {
    if (error?.code === 1) return false;
    snapshotError([diagnostic(
      'GIT_ANCESTRY_CHECK_FAILED', entry.id, 'ancestry', `git exit ${error?.code ?? 'unknown'}`,
      'successful argv-only git merge-base ancestry check',
      'restore readable Git history and retry snapshot capture',
    )]);
  }
}

async function captureGitHistoryPolicy(entry) {
  const replacements = (await runGit(entry.target, [
    'for-each-ref', '--format=%(refname)', 'refs/replace',
  ])).stdout.trim();
  if (replacements.length > 0) {
    snapshotError([diagnostic(
      'GIT_REPLACE_REFS_UNSUPPORTED', entry.id, 'history.replace_refs', 'one or more replacement refs', 'none',
      'remove replacement refs so every Git command observes the repository object database directly',
    )]);
  }
  const shallow = (await runGit(entry.target, ['rev-parse', '--is-shallow-repository'])).stdout.trim();
  if (shallow !== 'false') {
    snapshotError([diagnostic(
      'GIT_SHALLOW_HISTORY_UNSUPPORTED', entry.id, 'history.shallow', shallow || 'unknown', 'false',
      'use a complete non-shallow repository so exact forward ancestry can be proven locally',
    )]);
  }
  const graftsPath = (await runGit(entry.target, [
    'rev-parse', '--path-format=absolute', '--git-path', 'info/grafts',
  ])).stdout.trim();
  let grafts = 'absent';
  try {
    const stat = await lstat(graftsPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== 0) {
      snapshotError([diagnostic(
        'GIT_GRAFTS_UNSUPPORTED', entry.id, 'history.grafts', 'present or non-regular grafts metadata',
        'absent or empty regular info/grafts file',
        'remove fake ancestry metadata before capturing or verifying a snapshot',
      )]);
    }
    grafts = 'empty';
  } catch (error) {
    if (error instanceof SnapshotError) throw error;
    if (error?.code !== 'ENOENT') throw error;
  }
  return { grafts, shallow: false, replace_objects_ignored: true };
}

const SNAPSHOT_PHASES = ['capture', 'verify'];

async function captureGit(entry, root, declaredBaselineHead, phase) {
  const inside = await gitOutputOrNull(entry.target, ['rev-parse', '--is-inside-work-tree']);
  const topLevel = await gitOutputOrNull(entry.target, ['rev-parse', '--show-toplevel']);
  if (inside !== 'true' || topLevel === null || resolve(topLevel) !== resolve(entry.target)) {
    snapshotError([diagnostic(
      'GIT_WORKTREE_REQUIRED', entry.id, 'target', entry.target, 'Git worktree',
      'initialize the target as a Git worktree or point this entry at the intended worktree',
    )]);
  }

  const head = await gitMaterialOutputOrNull(entry.target, ['rev-parse', 'HEAD']);
  if (!head) {
    snapshotError([diagnostic(
      'GIT_HEAD_REQUIRED', entry.id, 'target', entry.target, 'Git worktree with a resolvable HEAD',
      'create or select a committed branch so the target has a resolvable HEAD',
    )]);
  }
  const objectFormat = (await runGitMaterial(entry.target, [
    'rev-parse', '--show-object-format=storage',
  ])).stdout.trim();
  if (!['sha1', 'sha256'].includes(objectFormat)) {
    snapshotError([diagnostic(
      'GIT_OBJECT_FORMAT_UNSUPPORTED', entry.id, 'object_format', objectFormat || 'unknown', 'sha1 or sha256',
      'use a supported Git repository object format before capturing or verifying a snapshot',
    )]);
  }
  const baselineHead = declaredBaselineHead ?? head;
  const history = await captureGitHistoryPolicy(entry);
  const ancestry = {
    baseline_head: baselineHead,
    current_head: head,
    is_ancestor: await proveGitAncestry(entry, baselineHead, head),
  };
  const branch = await gitOutputOrNull(entry.target, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const upstream = await gitOutputOrNull(entry.target, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  // require_branch / require_upstream / require_clean 是 **launch 前置条件**，不是 run-long 不变量：
  // 只在 capture baseline 阶段判定，verify 阶段一律跳过。重跑它们等于把 preflight 谓词施加到 run 之
  // 后的工作树上，而工作树此刻必然脏——脏的正是 allowed_mutations 声明允许的那个产物，于是
  // 「产出了正确结果」结构性必红。verify 的 git 边界完全由 baseline compare 负责，且更精确：branch
  // 与 upstream 有 GIT_BRANCH_CHANGED / GIT_UPSTREAM_CHANGED 钉住不得偏离 baseline，工作树有逐路径
  // 按 allowed_mutations 归类的比对。跳过的只是谓词判定——上面的 branch/upstream 与下面的
  // refs/tree/index/worktree 材料一项不少，compare 要用的输入完整。
  if (phase === 'capture') {
    const diagnostics = [];
    if (entry.require_branch && branch !== entry.require_branch) {
      diagnostics.push(diagnostic(
        'GIT_BRANCH_MISMATCH', entry.id, 'require_branch', branch ?? 'null', entry.require_branch,
        'switch to the declared branch before capturing the baseline',
      ));
    }
    if (entry.require_upstream === true && upstream === null) {
      diagnostics.push(diagnostic(
        'GIT_UPSTREAM_REQUIRED', entry.id, 'require_upstream', 'null', 'configured upstream',
        'configure an upstream or remove the requirement from the contract',
      ));
    }
    if (entry.require_clean === true) {
      const status = await runGitMaterial(entry.target, ['status', '--porcelain=v1']);
      if (status.stdout.length > 0) {
        diagnostics.push(diagnostic(
          'GIT_CLEAN_REQUIRED', entry.id, 'require_clean', 'dirty worktree', 'clean worktree',
          'commit, stash, or remove the dirty state before capturing the baseline',
        ));
      }
    }
    if (diagnostics.length) snapshotError(diagnostics);
  }

  const [status, refs, tree, index] = await Promise.all([
    runGitMaterial(entry.target, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    runGit(entry.target, ['for-each-ref', '--format=%(refname) %(objectname)']),
    runGitMaterial(entry.target, ['ls-tree', '-r', '-l', '-z', head]),
    runGitMaterial(entry.target, ['ls-files', '--stage', '-z']),
  ]);
  const refsMap = parseRefs(refs.stdout);
  if (Object.keys(refsMap).some((name) => name.startsWith('refs/replace/'))) {
    snapshotError([diagnostic(
      'GIT_REPLACE_REFS_UNSUPPORTED', entry.id, 'history.replace_refs', 'one or more replacement refs', 'none',
      'remove replacement refs so every Git command observes the repository object database directly',
    )]);
  }
  const porcelain = parsePorcelain(status.stdout);
  const worktree = [];
  for (const change of porcelain) {
    if (!safeGitRelativePath(change.path)) {
      snapshotError([diagnostic(
        'GIT_PATH_INVALID', entry.id, 'porcelain.path', change.path, 'safe relative Git path',
        'rename or remove the invalid Git path; a snapshot cannot represent it, so declaring it in allowed_mutations will not help',
      )]);
    }
    worktree.push(await capturePathState(resolve(entry.target, change.path), change.path, {
      root, entry: entry.id, field: 'target',
    }));
  }
  const treeEntries = await captureTreeMaterial(entry.target, tree.stdout, entry.id, objectFormat);
  const indexEntries = parseIndex(index.stdout);
  const effectivePaths = new Set([
    ...treeEntries.map((item) => item.path),
    ...indexEntries.map((item) => item.path),
    ...porcelain.flatMap((item) => [item.path, item.original_path].filter(Boolean)),
  ]);
  const effective = [];
  for (const pathname of [...effectivePaths].sort()) {
    if (!safeGitRelativePath(pathname)) {
      snapshotError([diagnostic(
        'GIT_PATH_INVALID', entry.id, 'effective.path', pathname, 'safe relative Git path',
        'rename or remove the invalid Git path; a snapshot cannot represent it, so declaring it in allowed_mutations will not help',
      )]);
    }
    effective.push(await capturePathState(resolve(entry.target, pathname), pathname, {
      root, entry: entry.id, field: 'target',
    }));
  }
  const effectiveTree = await captureEffectiveTree(entry.target, effective, treeEntries, entry.id);
  const inventory = await capturePathState(entry.target, '', {
    root, entry: entry.id, field: 'target', skipRootGitMetadata: true,
  });
  return {
    id: entry.id,
    type: 'git',
    target: entry.target,
    head,
    branch,
    upstream,
    ancestry,
    history,
    porcelain,
    worktree,
    tree: treeEntries,
    index: indexEntries,
    effective,
    effective_tree: effectiveTree,
    inventory,
    refs: refsMap,
  };
}

async function capturePath(entry, root) {
  let stat;
  try {
    stat = await lstat(entry.target);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      snapshotError([diagnostic(
        'PATH_REQUIRED', entry.id, 'target', entry.target, entry.require,
        'create the required path or correct the preflight target',
      )]);
    }
    throw error;
  }
  const actual = stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other';
  if (entry.require !== 'exists' && entry.require !== actual) {
    snapshotError([diagnostic(
      'PATH_TYPE_MISMATCH', entry.id, 'require', actual, entry.require,
      'correct the target type or update the contract entry',
    )]);
  }
  return {
    id: entry.id,
    type: 'path',
    target: entry.target,
    require: entry.require,
    state: await capturePathState(entry.target, '', { root, entry: entry.id, field: 'target' }),
  };
}

function presentEnvironment(entry, environment) {
  const diagnostics = [];
  const names = entry.requires_env ?? [];
  const present = [];
  for (const name of names) {
    if (environment[name] === undefined) {
      diagnostics.push(diagnostic(
        'REQUIRED_ENV_MISSING', entry.id, 'requires_env', name, 'present environment variable',
        'provide the named environment variable without adding its value to the contract or snapshot',
      ));
    } else {
      present.push({ name, present: true });
    }
  }
  if (diagnostics.length) snapshotError(diagnostics);
  return present;
}

async function captureCommand(entry, environment) {
  const environmentPresence = presentEnvironment(entry, environment);
  let result;
  try {
    result = await execFile(entry.argv[0], entry.argv.slice(1), {
      cwd: entry.cwd,
      env: environment,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    const observed = typeof error?.code === 'number' ? `exit code ${error.code}` : `command failed: ${entry.argv[0]}`;
    snapshotError([diagnostic(
      'COMMAND_FAILED', entry.id, 'argv', observed, 'exit code 0',
      'fix the argv command or its declared preconditions before capturing the snapshot',
    )]);
  }
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const captured = entry.capture === 'text'
    ? { stdout, stderr }
    : { stdout_sha256: digest(stdout), stderr_sha256: digest(stderr) };
  return {
    id: entry.id,
    type: 'command',
    cwd: entry.cwd,
    argv: Array.from(entry.argv),
    requires_env: environmentPresence,
    capture: entry.capture ?? 'hash',
    ...captured,
  };
}

function isAllowedFile(pathname, patterns) {
  return patterns.some((pattern) => {
    if (pattern.endsWith('/**')) {
      const root = resolve(pattern.slice(0, -3));
      const pathRelative = relative(root, pathname);
      return pathRelative.length > 0 && !pathRelative.startsWith(`..${sep}`) && pathRelative !== '..' && !pathRelative.startsWith(sep);
    }
    return resolve(pattern) === pathname;
  });
}

function inventoryMap(state) {
  const result = new Map();
  function visit(current) {
    if (current.type === 'directory') {
      result.set(current.path, JSON.stringify({
        path: current.path, type: current.type, mode: current.mode,
      }));
      current.entries.forEach(visit);
      return;
    }
    if (current.path !== '') result.set(current.path, JSON.stringify(stableJson(current)));
  }
  visit(state);
  return result;
}

function indexMap(entries) {
  return new Map(entries.map((entry) => [`${entry.path}:${entry.stage}`, JSON.stringify(stableJson(entry))]));
}

function stateArrayMap(entries) {
  return new Map(entries.map((entry) => [entry.path, entry]));
}

function projectedMaterial(entry) {
  if (entry === undefined) return { type: 'missing' };
  const material = { ...entry };
  delete material.path;
  return material;
}

function compareIndex(contract, baseline, current, result, ordinaryBranchCommit) {
  const before = indexMap(baseline.index);
  const after = indexMap(current.index);
  const baselineEffective = stateArrayMap(baseline.effective_tree);
  const currentTree = committedTreeMap(current.tree);
  for (const key of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    if (before.get(key) === after.get(key)) continue;
    const separator = key.lastIndexOf(':');
    const pathname = key.slice(0, separator);
    const absolutePath = resolve(baseline.target, pathname);
    if (isAllowedFile(absolutePath, contract.allowed_mutations.files)) {
      result.changes.push({ entry: baseline.id, kind: 'git_index', path: absolutePath });
    } else if (ordinaryBranchCommit
      && JSON.stringify(stableJson(projectedMaterial(baselineEffective.get(pathname))))
        === JSON.stringify(stableJson(effectiveCommittedMaterial(currentTree.get(pathname))))) {
      result.changes.push({ entry: baseline.id, kind: 'git_index_existing_material', path: absolutePath });
    } else {
      result.violations.push(diagnostic(
        'GIT_INDEX_MUTATION_NOT_ALLOWED', baseline.id, 'index', 'index entry changed',
        'index changes only for declared allowed files',
        'restore the protected index entry or narrowly authorize the file and recapture the baseline',
      ));
    }
  }
}

function committedTreeMap(entries) {
  return new Map(entries.map((entry) => [entry.path, entry]));
}

function committedMaterial(entry) {
  if (entry === undefined) return { type: 'missing' };
  if (entry.type === 'commit' && entry.mode === '160000') {
    return { type: 'gitlink', mode: entry.mode, object: entry.object };
  }
  if (entry.type !== 'blob') return { type: 'unsupported', mode: entry.mode, object: entry.object };
  if (entry.mode === '120000') {
    return { type: 'symlink', mode: entry.mode, bytes_sha256: entry.bytes_sha256 };
  }
  return {
    type: 'file',
    mode: entry.mode === '100755' ? '0755' : '0644',
    object: entry.object,
    bytes_sha256: entry.bytes_sha256,
  };
}

function effectiveCommittedMaterial(entry) {
  const material = committedMaterial(entry);
  if (material.type === 'file') delete material.bytes_sha256;
  return material;
}

function compareCommittedMaterial(contract, baseline, current, result) {
  const baselineTree = committedTreeMap(baseline.tree);
  const currentTree = committedTreeMap(current.tree);
  const baselineEffective = stateArrayMap(baseline.effective_tree);
  const paths = new Set([...baselineTree.keys(), ...currentTree.keys()]);
  const sameHead = baseline.head === current.head;

  for (const pathname of [...paths].sort()) {
    const beforeTree = baselineTree.get(pathname);
    const afterTree = currentTree.get(pathname);
    if (JSON.stringify(stableJson(beforeTree)) === JSON.stringify(stableJson(afterTree))) continue;

    const sameObjectIdentity = beforeTree !== undefined && afterTree !== undefined
      && beforeTree.mode === afterTree.mode && beforeTree.type === afterTree.type
      && beforeTree.object === afterTree.object;
    const absolutePath = resolve(baseline.target, pathname);
    if (sameHead || sameObjectIdentity) {
      result.violations.push(diagnostic(
        'GIT_COMMITTED_OBJECT_INTEGRITY_CHANGED', baseline.id, 'tree', absolutePath,
        'identical committed tree material for an unchanged HEAD or object identity',
        'restore the repository object database from a trusted source and recapture current state',
      ));
      continue;
    }

    const beforeMaterial = projectedMaterial(baselineEffective.get(pathname));
    const afterMaterial = effectiveCommittedMaterial(afterTree);
    const allowed = isAllowedFile(absolutePath, contract.allowed_mutations.files);
    if (JSON.stringify(stableJson(beforeMaterial)) === JSON.stringify(stableJson(afterMaterial))) {
      result.changes.push({
        entry: baseline.id,
        kind: allowed ? 'git_committed_material' : 'git_committed_existing_material',
        path: absolutePath,
      });
    } else if (allowed) {
      result.changes.push({ entry: baseline.id, kind: 'git_committed_material', path: absolutePath });
    } else {
      result.violations.push(diagnostic(
        'GIT_COMMITTED_MATERIAL_NOT_ALLOWED', baseline.id, 'tree', absolutePath,
        'committed bytes, mode, and type matching baseline effective material unless the path is declared allowed',
        'restore protected committed material or narrowly authorize the path and recapture the baseline',
      ));
    }
  }
}

function changedRefs(baselineRefs, currentRefs) {
  return [...new Set([...Object.keys(baselineRefs), ...Object.keys(currentRefs)])]
    .filter((name) => baselineRefs[name] !== currentRefs[name])
    .sort();
}

function pushFileDifference(result, contract, entry, pathname, source) {
  const absolutePath = resolve(entry.target, pathname);
  if (isAllowedFile(absolutePath, contract.allowed_mutations.files)) {
    result.changes.push({ entry: entry.id, kind: source, path: absolutePath });
  } else {
    result.violations.push(diagnostic(
      'FILE_MUTATION_NOT_ALLOWED', entry.id, 'allowed_mutations.files', absolutePath,
      'a declared exact file path or directory /** prefix',
      'revert the file change or add a narrowly scoped allowed file path and recapture the baseline',
    ));
  }
}

function compareGit(contract, baseline, current, result) {
  if (baseline.branch !== current.branch) {
    result.violations.push(diagnostic(
      'GIT_BRANCH_CHANGED', baseline.id, 'branch', current.branch ?? 'null', baseline.branch ?? 'detached HEAD',
      'return to the baseline branch before completing the run',
    ));
  }
  if (baseline.upstream !== current.upstream) {
    result.violations.push(diagnostic(
      'GIT_UPSTREAM_CHANGED', baseline.id, 'upstream', current.upstream ?? 'null', baseline.upstream ?? 'null',
      'restore the baseline upstream configuration before completing the run',
    ));
  }

  const canCommit = contract.allowed_mutations.git.includes('commit');
  const refChanges = changedRefs(baseline.refs, current.refs);
  const branchRef = baseline.branch && baseline.branch === current.branch
    ? `refs/heads/${baseline.branch}` : null;
  const baselineAncestryValid = baseline.ancestry.baseline_head === baseline.head
    && baseline.ancestry.current_head === baseline.head
    && baseline.ancestry.is_ancestor === true;
  const currentAncestryBound = current.ancestry.baseline_head === baseline.head
    && current.ancestry.current_head === current.head;
  const forwardAncestry = baselineAncestryValid && currentAncestryBound
    && current.ancestry.is_ancestor === true;
  if (!baselineAncestryValid || !currentAncestryBound
    || (baseline.head === current.head && current.ancestry.is_ancestor !== true)) {
    result.violations.push(diagnostic(
      'GIT_ANCESTRY_EVIDENCE_INVALID', baseline.id, 'ancestry', 'unbound or inconsistent ancestry evidence',
      'argv-only ancestry evidence bound to exact externally trusted baseline HEAD and captured current HEAD',
      'recapture current state against baselineGitHeads derived from the externally digest-validated baseline',
    ));
  }
  const ordinaryBranchCommit = canCommit
    && baseline.head !== current.head
    && forwardAncestry
    && branchRef !== null
    && baseline.refs[branchRef] === baseline.head
    && current.refs[branchRef] === current.head
    && refChanges.length === 1
    && refChanges[0] === branchRef;
  if (baseline.head !== current.head) {
    if (!canCommit) {
      result.violations.push(diagnostic(
        'GIT_COMMIT_NOT_ALLOWED', baseline.id, 'allowed_mutations.git', current.head, 'no HEAD change',
        'reset the undeclared commit or declare commit as an allowed Git mutation before recapturing the baseline',
      ));
    } else if (ordinaryBranchCommit) {
      result.changes.push({ entry: baseline.id, kind: 'git_head', path: current.head });
    } else if (baselineAncestryValid && currentAncestryBound && !current.ancestry.is_ancestor) {
      result.violations.push(diagnostic(
        'GIT_COMMIT_NOT_FORWARD', baseline.id, 'ancestry', current.head,
        `descendant of exact baseline HEAD ${baseline.head}`,
        'restore the baseline branch or create an allowed forward descendant commit',
      ));
    }
  }

  if (refChanges.length > 0) {
    if (ordinaryBranchCommit) {
      result.changes.push({ entry: baseline.id, kind: 'git_current_branch_ref', path: branchRef });
    } else {
      result.violations.push(diagnostic(
        'GIT_REFS_CHANGED', baseline.id, 'refs', `changed ref count ${refChanges.length}`,
        'only the current branch ref moving exactly from baseline HEAD to an allowed commit',
        'remove undeclared tags or ref changes and restore the baseline ref topology',
      ));
    }
  } else if (baseline.head !== current.head && canCommit) {
    result.violations.push(diagnostic(
      'GIT_COMMIT_REF_INCONSISTENT', baseline.id, 'refs', 'HEAD moved without the matching current branch ref',
      'current branch ref exactly matching the allowed commit',
      'restore a consistent branch and HEAD state before completing the run',
    ));
  }

  compareIndex(contract, baseline, current, result, ordinaryBranchCommit);
  compareCommittedMaterial(contract, baseline, current, result);

  const baselineInventory = inventoryMap(baseline.inventory);
  const currentInventory = inventoryMap(current.inventory);
  const inventoryPaths = new Set([...baselineInventory.keys(), ...currentInventory.keys()]);
  for (const pathname of [...inventoryPaths].sort()) {
    if (baselineInventory.get(pathname) !== currentInventory.get(pathname)) {
      pushFileDifference(result, contract, baseline, pathname, 'working_tree_inventory');
    }
  }

}

function comparePath(contract, baseline, current, result) {
  if (JSON.stringify(stableJson(baseline.state)) === JSON.stringify(stableJson(current.state))) return;
  const target = resolve(baseline.target);
  if (isAllowedFile(target, contract.allowed_mutations.files)) {
    result.changes.push({ entry: baseline.id, kind: 'path', path: target });
    return;
  }
  result.violations.push(diagnostic(
    'PATH_MUTATION_NOT_ALLOWED', baseline.id, 'allowed_mutations.files', target,
    'a declared exact file path or directory /** prefix',
    'restore the path or declare a narrowly scoped allowed file path and recapture the baseline',
  ));
}

function compareCommand(baseline, current, result) {
  const before = JSON.stringify(stableJson(baseline));
  const after = JSON.stringify(stableJson(current));
  if (before === after) return;
  result.violations.push(diagnostic(
    'COMMAND_SNAPSHOT_CHANGED', baseline.id, 'output', 'captured output changed', 'unchanged captured output',
    'investigate the command output difference before completing the run',
  ));
}

export async function captureSnapshot(contract, options = {}) {
  // 阶段由调用方显式声明，不从 baselineGitHeads 在不在这类旁证上猜——git preflight 谓词是否施加取决
  // 于它，猜错要么放过 launch 前置条件，要么让 verify 结构性必红。**必填**：缺省成 capture 会让将来
  // 漏传的 verify 类调用点静默退回「产出正确结果反而必红」，而那正是这个参数被引入要消灭的形态；
  // 漏传与非闭集取值一样 fail-closed。
  const { phase } = options;
  if (!SNAPSHOT_PHASES.includes(phase)) {
    snapshotError([diagnostic(
      'SNAPSHOT_PHASE_INVALID', 'snapshot', 'phase', String(phase), 'capture or verify',
      'declare the snapshot phase explicitly at the call site',
    )]);
  }
  const diagnostics = contractDiagnostics(contract);
  if (diagnostics.length) snapshotError(diagnostics);
  const root = validateTargetRoot(contract);
  const patternDiagnostics = validateAllowedFilePatterns(contract);
  if (patternDiagnostics.length) snapshotError(patternDiagnostics);
  await validateSnapshotBoundary(contract, root);
  const contexts = await captureContexts(contract, root);

  const environment = options.env ?? process.env;
  const baselineGitHeads = options.baselineGitHeads;
  const gitEntries = contract.preflight.filter((entry) => entry.type === 'git');
  if (baselineGitHeads !== undefined) {
    const expectedIds = gitEntries.map((entry) => entry.id).sort();
    const actualIds = isObject(baselineGitHeads) ? Object.keys(baselineGitHeads).sort() : [];
    const validHeads = isObject(baselineGitHeads)
      && Object.values(baselineGitHeads).every((head) => typeof head === 'string' && /^[0-9a-f]{40,64}$/.test(head));
    if (!validHeads || JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
      snapshotError([diagnostic(
        'GIT_BASELINE_HEADS_INVALID', 'snapshot', 'baselineGitHeads', JSON.stringify(actualIds),
        `exact Git preflight ids with object hashes: ${JSON.stringify(expectedIds)}`,
        'derive baselineGitHeads from the externally digest-validated baseline snapshot',
      )]);
    }
  }
  const entries = [];
  for (const entry of contract.preflight) {
    if (entry.type === 'git') entries.push(await captureGit(entry, root, baselineGitHeads?.[entry.id], phase));
    else if (entry.type === 'path') entries.push(await capturePath(entry, root));
    else if (entry.type === 'command') entries.push(await captureCommand(entry, environment));
    else snapshotError([diagnostic(
      'PREFLIGHT_TYPE_INVALID', entry.id ?? 'unknown', 'type', entry.type, 'git, path, or command',
      'correct the preflight entry type before capturing a snapshot',
    )]);
  }
  return {
    schema_version: 3,
    contract_hash: contractHash(contract),
    captured_at: new Date().toISOString(),
    contexts,
    entries,
  };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return isObject(value) && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function isDigest(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function snapshotEntryDiagnostic(entry, field, observed, expected) {
  return diagnostic(
    'SNAPSHOT_ENTRY_INVALID', entry, field, observed, expected,
    'regenerate the snapshot from the unchanged contract; do not edit snapshot payloads',
  );
}

function validateCapturedPathState(state, entry, field, allowEmptyPath = false) {
  const diagnostics = [];
  if (!isObject(state) || typeof state.type !== 'string' || typeof state.path !== 'string'
    || (!allowEmptyPath && !safeGitRelativePath(state.path))) {
    return [snapshotEntryDiagnostic(entry, field, 'malformed path state', 'closed snapshot path state')];
  }
  if (state.type === 'file') {
    if (!hasExactKeys(state, ['path', 'type', 'mode', 'bytes_sha256']) || !isDigest(state.bytes_sha256) || !/^[0-7]{4}$/.test(state.mode)) {
      diagnostics.push(snapshotEntryDiagnostic(entry, field, 'malformed file state', 'file path state with mode and SHA-256 bytes hash'));
    }
  } else if (state.type === 'missing') {
    if (!hasExactKeys(state, ['path', 'type'])) diagnostics.push(snapshotEntryDiagnostic(entry, field, 'malformed missing state', 'missing path state'));
  } else if (state.type === 'symlink') {
    if (!hasExactKeys(state, ['path', 'type', 'mode', 'target']) || !/^[0-7]{4}$/.test(state.mode) || typeof state.target !== 'string') {
      diagnostics.push(snapshotEntryDiagnostic(entry, field, 'malformed symlink state', 'symlink path state with target'));
    }
  } else if (state.type === 'other') {
    if (!hasExactKeys(state, ['path', 'type', 'mode']) || !/^[0-7]{4}$/.test(state.mode)) diagnostics.push(snapshotEntryDiagnostic(entry, field, 'malformed other state', 'other path state with mode'));
  } else if (state.type === 'directory') {
    if (!hasExactKeys(state, ['path', 'type', 'mode', 'entries']) || !/^[0-7]{4}$/.test(state.mode) || !Array.isArray(state.entries)) {
      diagnostics.push(snapshotEntryDiagnostic(entry, field, 'malformed directory state', 'directory path state with entries'));
    } else {
      state.entries.forEach((child) => diagnostics.push(...validateCapturedPathState(child, entry, field)));
    }
  } else {
    diagnostics.push(snapshotEntryDiagnostic(entry, field, state.type, 'file, missing, symlink, directory, or other state'));
  }
  return diagnostics;
}

function validateSnapshotEntry(entry, expected) {
  const diagnostics = [];
  if (!isObject(entry)) return [snapshotEntryDiagnostic(expected.id, 'entries', 'non-object entry', 'closed snapshot entry')];
  if (expected.type === 'git') {
    const keys = ['id', 'type', 'target', 'head', 'branch', 'upstream', 'ancestry', 'history', 'porcelain', 'worktree', 'tree', 'index', 'effective', 'effective_tree', 'inventory', 'refs'];
    if (!hasExactKeys(entry, keys)) diagnostics.push(snapshotEntryDiagnostic(expected.id, 'entries', 'unexpected Git entry fields', 'closed Git snapshot entry'));
    if (!/^[0-9a-f]{40,64}$/.test(entry.head ?? '')) {
      diagnostics.push(snapshotEntryDiagnostic(expected.id, 'head', entry.head ?? 'missing', 'Git object hash'));
    }
    if (!(typeof entry.branch === 'string' || entry.branch === null) || !(typeof entry.upstream === 'string' || entry.upstream === null)) {
      diagnostics.push(snapshotEntryDiagnostic(expected.id, 'branch', 'malformed branch/upstream', 'string or null branch and upstream'));
    }
    if (!hasExactKeys(entry.ancestry, ['baseline_head', 'current_head', 'is_ancestor'])
      || !/^[0-9a-f]{40,64}$/.test(entry.ancestry?.baseline_head ?? '')
      || !/^[0-9a-f]{40,64}$/.test(entry.ancestry?.current_head ?? '')
      || typeof entry.ancestry?.is_ancestor !== 'boolean') {
      diagnostics.push(snapshotEntryDiagnostic(expected.id, 'ancestry', 'malformed ancestry evidence', 'exact baseline/current object hashes and boolean ancestry result'));
    }
    if (!hasExactKeys(entry.history, ['grafts', 'shallow', 'replace_objects_ignored'])
      || !['absent', 'empty'].includes(entry.history?.grafts)
      || entry.history?.shallow !== false || entry.history?.replace_objects_ignored !== true) {
      diagnostics.push(snapshotEntryDiagnostic(expected.id, 'history', 'malformed Git history policy evidence', 'non-shallow history without grafts and with replace objects ignored'));
    }
    for (const field of ['porcelain', 'worktree', 'tree', 'index', 'effective', 'effective_tree']) {
      if (!Array.isArray(entry[field])) diagnostics.push(snapshotEntryDiagnostic(expected.id, field, 'non-array', 'array'));
    }
    if (Array.isArray(entry.porcelain)) {
      entry.porcelain.forEach((item) => {
        if (!isObject(item) || !['code', 'path', 'original_path'].every((key) => key in item || key === 'original_path')
          || typeof item.code !== 'string' || !safeGitRelativePath(item.path)
          || (item.original_path !== undefined && !safeGitRelativePath(item.original_path))) {
          diagnostics.push(snapshotEntryDiagnostic(expected.id, 'porcelain', 'malformed porcelain entry', 'safe structured porcelain entry'));
        }
      });
    }
    if (Array.isArray(entry.worktree)) entry.worktree.forEach((state) => diagnostics.push(...validateCapturedPathState(state, expected.id, 'worktree')));
    if (Array.isArray(entry.effective)) entry.effective.forEach((state) => diagnostics.push(...validateCapturedPathState(state, expected.id, 'effective')));
    if (Array.isArray(entry.effective_tree)) entry.effective_tree.forEach((item) => {
      const safePath = safeGitRelativePath(item?.path);
      const file = item?.type === 'file'
        && hasExactKeys(item, ['path', 'type', 'mode', 'object'])
        && /^[0-7]{4}$/.test(item.mode) && /^[0-9a-f]{40,64}$/.test(item.object);
      const symlink = item?.type === 'symlink'
        && hasExactKeys(item, ['path', 'type', 'mode', 'bytes_sha256'])
        && item.mode === '120000' && isDigest(item.bytes_sha256);
      const missing = item?.type === 'missing' && hasExactKeys(item, ['path', 'type']);
      const gitlink = item?.type === 'gitlink'
        && hasExactKeys(item, ['path', 'type', 'mode', 'object'])
        && item.mode === '160000' && /^[0-9a-f]{40,64}$/.test(item.object);
      const other = item?.type === 'other'
        && hasExactKeys(item, ['path', 'type', 'mode']) && /^[0-7]{4}$/.test(item.mode);
      if (!safePath || !(file || symlink || missing || gitlink || other)) {
        diagnostics.push(snapshotEntryDiagnostic(expected.id, 'effective_tree', 'malformed effective Git material', 'safe closed Git-projected effective material'));
      }
    });
    diagnostics.push(...validateCapturedPathState(entry.inventory, expected.id, 'inventory', true));
    if (Array.isArray(entry.tree)) entry.tree.forEach((item) => {
      const blob = item?.type === 'blob';
      const gitlink = item?.type === 'commit';
      const keysValid = blob
        ? hasExactKeys(item, ['mode', 'type', 'object', 'path', 'bytes_sha256'])
        : hasExactKeys(item, ['mode', 'type', 'object', 'path']);
      if (!keysValid || !safeGitRelativePath(item.path) || !/^[0-9a-f]{40,64}$/.test(item.object)
        || (blob && (!/^(?:100644|100755|120000)$/.test(item.mode) || !isDigest(item.bytes_sha256)))
        || (gitlink && item.mode !== '160000') || (!blob && !gitlink)) {
        diagnostics.push(snapshotEntryDiagnostic(expected.id, 'tree', 'malformed tree entry', 'safe Git tree entry'));
      }
    });
    if (Array.isArray(entry.index)) entry.index.forEach((item) => {
      if (!hasExactKeys(item, ['mode', 'object', 'stage', 'path'])
        || !/^(?:100644|100755|120000|160000)$/.test(item.mode)
        || !/^[0-9a-f]{40,64}$/.test(item.object)
        || !Number.isInteger(item.stage) || item.stage < 0 || item.stage > 3
        || !safeGitRelativePath(item.path)) {
        diagnostics.push(snapshotEntryDiagnostic(expected.id, 'index', 'malformed index entry', 'mode, object, stage, and safe path'));
      }
    });
    if (!isObject(entry.refs) || Object.entries(entry.refs).some(([name, object]) => (
      !/^refs\/\S+$/.test(name) || !/^[0-9a-f]{40,64}$/.test(object)
    ))) {
      diagnostics.push(snapshotEntryDiagnostic(expected.id, 'refs', 'malformed refs map', 'structured ref-name to object map'));
    }
  } else if (expected.type === 'path') {
    if (!hasExactKeys(entry, ['id', 'type', 'target', 'require', 'state'])) {
      diagnostics.push(snapshotEntryDiagnostic(expected.id, 'entries', 'unexpected path entry fields', 'closed path snapshot entry'));
    }
    diagnostics.push(...validateCapturedPathState(entry.state, expected.id, 'state', true));
  } else if (expected.type === 'command') {
    const keys = entry.capture === 'text'
      ? ['id', 'type', 'cwd', 'argv', 'requires_env', 'capture', 'stdout', 'stderr']
      : ['id', 'type', 'cwd', 'argv', 'requires_env', 'capture', 'stdout_sha256', 'stderr_sha256'];
    if (!hasExactKeys(entry, keys)) diagnostics.push(snapshotEntryDiagnostic(expected.id, 'entries', 'unexpected command entry fields', 'closed command snapshot entry'));
    if (!Array.isArray(entry.argv) || entry.argv.some((value) => typeof value !== 'string') || !Array.isArray(entry.requires_env)) {
      diagnostics.push(snapshotEntryDiagnostic(expected.id, 'argv', 'malformed command argv or environment presence', 'argv strings and environment presence array'));
    }
    if (Array.isArray(entry.requires_env) && entry.requires_env.some((item) => !hasExactKeys(item, ['name', 'present']) || typeof item.name !== 'string' || item.present !== true)) {
      diagnostics.push(snapshotEntryDiagnostic(expected.id, 'requires_env', 'environment value or malformed presence', 'name and present=true only'));
    }
    if (entry.capture !== 'text' && (!isDigest(entry.stdout_sha256) || !isDigest(entry.stderr_sha256))) {
      diagnostics.push(snapshotEntryDiagnostic(expected.id, 'output', 'malformed output hash', 'SHA-256 output hashes'));
    }
    if (entry.capture === 'text' && (typeof entry.stdout !== 'string' || typeof entry.stderr !== 'string')) {
      diagnostics.push(snapshotEntryDiagnostic(expected.id, 'output', 'malformed text output', 'string stdout and stderr'));
    }
  }
  return diagnostics;
}

export function snapshotDiagnostics(contract, snapshot) {
  const diagnostics = [];
  if (!hasExactKeys(snapshot, ['schema_version', 'contract_hash', 'captured_at', 'contexts', 'entries'])) {
    diagnostics.push(diagnostic(
      'SNAPSHOT_SCHEMA_INVALID', 'snapshot', 'snapshot', 'unexpected snapshot fields', 'closed snapshot top-level fields',
      'regenerate the snapshot with the supported snapshot schema',
    ));
  }
  const expectedHash = contractHash(contract);
  if (snapshot?.contract_hash !== expectedHash) {
    diagnostics.push(diagnostic(
      'CONTRACT_HASH_MISMATCH', 'contract', 'contract_hash', snapshot?.contract_hash ?? 'missing', expectedHash,
      'use the confirmed contract unchanged and recapture the baseline',
    ));
  }
  if (snapshot?.schema_version !== 3) {
    diagnostics.push(diagnostic(
      'SNAPSHOT_SCHEMA_INVALID', 'snapshot', 'schema_version', snapshot?.schema_version ?? 'missing', '3',
      'regenerate the snapshot with the supported snapshot schema',
    ));
  }
  if (typeof snapshot?.captured_at !== 'string' || Number.isNaN(Date.parse(snapshot.captured_at))) {
    diagnostics.push(diagnostic(
      'SNAPSHOT_CAPTURE_TIME_MISSING', 'snapshot', 'captured_at', snapshot?.captured_at ?? 'missing', 'ISO timestamp',
      'regenerate the snapshot before launch or verification',
    ));
  }
  const expectedContexts = contract?.context_sources ?? [];
  const actualContexts = Array.isArray(snapshot?.contexts) ? snapshot.contexts : [];
  if (expectedContexts.length !== actualContexts.length) {
    diagnostics.push(diagnostic(
      'SNAPSHOT_CONTEXT_SET_MISMATCH', 'snapshot', 'contexts', actualContexts.length, expectedContexts.length,
      'recapture the complete context-bound snapshot from the unchanged contract',
    ));
  }
  const actualContextsById = new Map(actualContexts.filter(isObject).map((context) => [context.id, context]));
  for (const expected of expectedContexts) {
    const actual = actualContextsById.get(expected.id);
    if (!hasExactKeys(actual, ['id', 'path', 'sha256', 'mode'])
      || actual.path !== expected.path || actual.sha256 !== expected.sha256 || !/^[0-7]{4}$/.test(actual.mode ?? '')) {
      diagnostics.push(diagnostic(
        'SNAPSHOT_CONTEXT_INVALID', expected.id, 'contexts', 'malformed or contract-mismatched context state',
        'closed context state matching id, path, SHA-256, and file mode',
        'recapture the baseline from the unchanged context-bound contract',
      ));
    }
  }
  const expectedEntries = contract?.preflight ?? [];
  const actualEntries = Array.isArray(snapshot?.entries) ? snapshot.entries : [];
  const expectedSet = new Set(expectedEntries.map((entry) => `${entry.id}:${entry.type}`));
  const actualSet = new Set(actualEntries.map((entry) => `${entry?.id}:${entry?.type}`));
  if (expectedSet.size !== actualEntries.length || actualSet.size !== actualEntries.length
    || expectedSet.size !== actualSet.size || [...expectedSet].some((entry) => !actualSet.has(entry))) {
    diagnostics.push(diagnostic(
      'SNAPSHOT_ENTRY_SET_MISMATCH', 'snapshot', 'entries', [...actualSet].sort().join(',') || 'none',
      [...expectedSet].sort().join(',') || 'none',
      'recapture a complete baseline from the unchanged contract before launch or verification',
    ));
  }
  const actualById = new Map(actualEntries.filter(isObject).map((entry) => [entry.id, entry]));
  for (const expected of expectedEntries) {
    const actual = actualById.get(expected.id);
    if (!actual || actual.type !== expected.type) continue;
    diagnostics.push(...validateSnapshotEntry(actual, expected));
    const field = expected.type === 'command' ? 'cwd' : 'target';
    const expectedTarget = expected.type === 'command' ? expected.cwd : expected.target;
    const actualTarget = expected.type === 'command' ? actual.cwd : actual.target;
    if (actualTarget !== expectedTarget) {
      diagnostics.push(diagnostic(
        'SNAPSHOT_ENTRY_CONTRACT_MISMATCH', expected.id, field, actualTarget ?? 'missing', expectedTarget,
        'recapture the snapshot from the unchanged contract',
      ));
    }
    if (expected.type === 'command' && JSON.stringify(actual.argv) !== JSON.stringify(expected.argv)) {
      diagnostics.push(diagnostic(
        'SNAPSHOT_ENTRY_CONTRACT_MISMATCH', expected.id, 'argv', JSON.stringify(actual.argv), JSON.stringify(expected.argv),
        'recapture the snapshot from the unchanged contract',
      ));
    }
  }
  return diagnostics;
}

export function compareSnapshot(contract, baseline, current, options = {}) {
  const result = { ok: false, changes: [], violations: [] };
  const expectedBaselineDigest = options.expectedBaselineDigest;
  if (!isDigest(expectedBaselineDigest)) {
    result.violations.push(diagnostic(
      'EXPECTED_BASELINE_DIGEST_REQUIRED', 'baseline', 'expectedBaselineDigest', expectedBaselineDigest ?? 'missing',
      'trusted external SHA-256 baseline digest',
      'persist the digest printed by capture in confirmed orchestration state and supply it to verify',
    ));
  } else if (snapshotDigest(baseline) !== expectedBaselineDigest) {
    result.violations.push(diagnostic(
      'BASELINE_DIGEST_MISMATCH', 'baseline', 'expectedBaselineDigest', snapshotDigest(baseline), expectedBaselineDigest,
      'reject the mutable baseline payload and recover the original baseline referenced by trusted orchestration state',
    ));
  }
  const baselineDiagnostics = snapshotDiagnostics(contract, baseline);
  const currentDiagnostics = snapshotDiagnostics(contract, current);
  result.violations.push(...baselineDiagnostics, ...currentDiagnostics);
  if (baselineDiagnostics.length || currentDiagnostics.length) return result;
  const currentContexts = new Map((current.contexts ?? []).map((context) => [context.id, context]));
  for (const baselineContext of baseline.contexts ?? []) {
    const currentContext = currentContexts.get(baselineContext.id);
    if (JSON.stringify(stableJson(baselineContext)) !== JSON.stringify(stableJson(currentContext))) {
      result.violations.push(diagnostic(
        'CONTEXT_STATE_CHANGED', baselineContext.id, 'contexts', 'context bytes or mode changed',
        'context state identical to the externally bound baseline',
        'restore the confirmed context or generate, preview, and confirm a new contract and baseline',
      ));
    }
  }
  const currentEntries = new Map((current?.entries ?? []).map((entry) => [entry.id, entry]));
  for (const baselineEntry of baseline?.entries ?? []) {
    const currentEntry = currentEntries.get(baselineEntry.id);
    if (!currentEntry) {
      result.violations.push(diagnostic(
        'SNAPSHOT_ENTRY_MISSING', baselineEntry.id, 'entries', 'missing', 'matching current snapshot entry',
        'recapture the current snapshot with the unchanged contract',
      ));
      continue;
    }
    if (baselineEntry.type !== currentEntry.type) {
      result.violations.push(diagnostic(
        'SNAPSHOT_ENTRY_TYPE_CHANGED', baselineEntry.id, 'type', currentEntry.type, baselineEntry.type,
        'recapture both snapshots from the same contract',
      ));
      continue;
    }
    if (baselineEntry.type === 'git') compareGit(contract, baselineEntry, currentEntry, result);
    else if (baselineEntry.type === 'path') comparePath(contract, baselineEntry, currentEntry, result);
    else if (baselineEntry.type === 'command') compareCommand(baselineEntry, currentEntry, result);
  }
  result.ok = result.violations.length === 0;
  return result;
}
