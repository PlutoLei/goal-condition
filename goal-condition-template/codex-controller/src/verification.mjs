import { execFileSync, spawn } from 'node:child_process';
import {
  accessSync, constants, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  readlinkSync, realpathSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { completionLevel, recordEvidence } from './evidence.mjs';

const OUTPUT_LIMIT = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 180_000;
const PROCESS_HEADROOM = 32;
const COMMAND_LINE_TOOLS = '/Library/Developer/CommandLineTools';
const SYSTEM_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
const OPTIONAL_TOOL_PATHS = ['/opt/homebrew/bin', '/usr/local/bin'];
const AUXILIARY_TOOL_COMMANDS = ['codesign', 'node', 'swift'];
const RUNTIME_PATH = [
  ...SYSTEM_PATH,
  ...OPTIONAL_TOOL_PATHS.filter((path) => existsSync(path)),
];
const SYSTEM_RUNTIME_PREFIXES = ['/System/', '/usr/lib/'];
const SYSTEM_RUNTIME_READ_ROOTS = ['/System', '/usr/lib', '/Library/Apple'];
const OPTIONAL_RUNTIME_READ_ROOTS = [
  COMMAND_LINE_TOOLS,
  '/opt/homebrew/opt/openssl@3', '/usr/local/opt/openssl@3',
  '/opt/homebrew/etc/openssl@3', '/usr/local/etc/openssl@3',
];
const HOMEBREW_CELLARS = ['/opt/homebrew/Cellar', '/usr/local/Cellar'];
const MAX_RUNTIME_OBJECTS = 128;
const DARWIN_SHELL_SELECTOR = '/private/var/select/sh';
const XCRUN_RUNTIME = '/Library/Developer/CommandLineTools/usr/lib/libxcrun.dylib';
const TRUST_QUALIFICATION_RELATIVE = 'tools/codex/compute-control/qualification/local';
const TRUST_QUALIFICATION_FILES = [
  'component-set.candidate.json',
  'offline-test-evidence.json',
];

function verificationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function inside(root, candidate) {
  const delta = relative(root, candidate);
  return delta === '' || (!delta.startsWith('..') && !isAbsolute(delta));
}

function bounded(chunks) {
  const bytes = Buffer.concat(chunks);
  return bytes.byteLength <= OUTPUT_LIMIT ? bytes : bytes.subarray(0, OUTPUT_LIMIT);
}

function seatbeltLiteral(value) {
  return JSON.stringify(value);
}

function executableCandidates(command, path = process.env.PATH ?? '') {
  return isAbsolute(command)
    ? [command]
    : path.split(':').filter(Boolean).map((root) => resolve(root, command));
}

function resolveExecutablePath(command, path) {
  for (const candidate of executableCandidates(command, path)) {
    try {
      accessSync(candidate, constants.X_OK);
      return { invokedPath: resolve(candidate), executable: realpathSync(candidate) };
    } catch { /* try the next deterministic PATH entry */ }
  }
  throw verificationError('VERIFIER_EXECUTABLE_UNAVAILABLE', 'verifier executable cannot be resolved');
}

function cellarVersionRoot(path) {
  for (const cellar of HOMEBREW_CELLARS) {
    const delta = relative(cellar, path);
    if (delta.startsWith('..') || isAbsolute(delta)) continue;
    const [formula, version] = delta.split('/');
    if (formula && version) return join(cellar, formula, version);
  }
  return null;
}

function systemRuntime(path) {
  return SYSTEM_RUNTIME_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function machoRpaths(path, executable) {
  try {
    const lines = execFileSync('/usr/bin/otool', ['-l', path], { encoding: 'utf8' }).split('\n');
    const rpaths = [];
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index].trim() !== 'cmd LC_RPATH') continue;
      const match = lines.slice(index + 1, index + 4).join('\n').match(/\bpath (.+) \(offset \d+\)/);
      if (!match) continue;
      rpaths.push(match[1]
        .replaceAll('@loader_path', dirname(path))
        .replaceAll('@executable_path', dirname(executable)));
    }
    return rpaths;
  } catch {
    return [];
  }
}

function resolveMachODependency(reference, objectPath, executable) {
  if (systemRuntime(reference)) return null;
  const candidates = [];
  if (isAbsolute(reference)) candidates.push(reference);
  else if (reference.startsWith('@loader_path/')) {
    candidates.push(resolve(dirname(objectPath), reference.slice('@loader_path/'.length)));
  } else if (reference.startsWith('@executable_path/')) {
    candidates.push(resolve(dirname(executable), reference.slice('@executable_path/'.length)));
  } else if (reference.startsWith('@rpath/')) {
    const suffix = reference.slice('@rpath/'.length);
    candidates.push(...machoRpaths(objectPath, executable).map((root) => resolve(root, suffix)));
  }
  const candidate = candidates.find((path) => existsSync(path));
  if (candidate !== undefined) return candidate;
  throw verificationError(
    'VERIFIER_RUNTIME_DEPENDENCY_UNRESOLVED',
    'verifier runtime dependency cannot be resolved without broad host access',
  );
}

function machoDependencies(path, executable) {
  let output;
  try {
    output = execFileSync('/usr/bin/otool', ['-L', path], { encoding: 'utf8' });
  } catch {
    return null;
  }
  return output.split('\n').slice(1).map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/ \(compatibility version.*$/, ''))
    .map((reference) => resolveMachODependency(reference, path, executable))
    .filter(Boolean);
}

function selectedDeveloperTool(path) {
  let output;
  try {
    output = execFileSync('/usr/bin/otool', ['-L', path], { encoding: 'utf8' });
  } catch {
    return null;
  }
  if (!output.includes('/usr/lib/libxcselect.dylib')) return null;
  try {
    const selected = execFileSync('/usr/bin/xcrun', ['--find', basename(path)], { encoding: 'utf8' }).trim();
    if (!isAbsolute(selected) || !existsSync(selected)) return null;
    return { invokedPath: resolve(selected), executable: realpathSync(selected) };
  } catch {
    return null;
  }
}

function frameworkVersionRoot(path) {
  const match = path.match(/^(.+\.framework\/Versions\/[^/]+)(?:\/|$)/);
  return match?.[1] ?? null;
}

function scriptInterpreters(path, searchPath) {
  const firstLine = readFileSync(path).subarray(0, 4096).toString('utf8').split('\n', 1)[0];
  if (!firstLine.startsWith('#!')) return [];
  const words = firstLine.slice(2).trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  if (words[0] === '/usr/bin/env') {
    const command = words[1] === '-S' ? words[2] : words.find((word, index) => index > 0 && !word.startsWith('-'));
    if (!command) return [];
    return [resolveExecutablePath('/usr/bin/env', searchPath), resolveExecutablePath(command, searchPath)];
  }
  if (!isAbsolute(words[0])) return [];
  return [resolveExecutablePath(words[0], searchPath)];
}

function runtimeAccess({ invokedPath, executable, runtimeBin }) {
  const readFiles = new Set([invokedPath, executable]);
  const readRoots = new Set();
  const readMetadata = new Set();
  const pending = [executable];
  const inspected = new Set();
  const searchPath = [...new Set([runtimeBin, ...RUNTIME_PATH])].join(':');
  while (pending.length > 0) {
    if (inspected.size >= MAX_RUNTIME_OBJECTS) {
      throw verificationError('VERIFIER_RUNTIME_DEPENDENCY_LIMIT', 'verifier runtime dependency graph is too large');
    }
    const next = pending.shift();
    const canonical = realpathSync(next);
    if (inspected.has(canonical) || systemRuntime(canonical)) continue;
    inspected.add(canonical);
    const packagedRoot = cellarVersionRoot(canonical) ?? frameworkVersionRoot(canonical);
    if (packagedRoot === null) readFiles.add(canonical);
    else readRoots.add(packagedRoot);
    const interpreters = scriptInterpreters(canonical, searchPath);
    if (interpreters.length > 0) {
      for (const interpreter of interpreters) {
        readFiles.add(interpreter.invokedPath);
        readFiles.add(interpreter.executable);
        pending.push(interpreter.executable);
      }
      continue;
    }
    const selected = selectedDeveloperTool(canonical);
    if (selected !== null) {
      readFiles.add(selected.invokedPath);
      readFiles.add(selected.executable);
      const commandLineTool = inside(COMMAND_LINE_TOOLS, selected.executable);
      if (commandLineTool) {
        readMetadata.add('/Library');
        readMetadata.add('/Library/Developer');
        readRoots.add(COMMAND_LINE_TOOLS);
      }
      if (existsSync(XCRUN_RUNTIME)) readFiles.add(XCRUN_RUNTIME);
      const selectedFramework = frameworkVersionRoot(selected.executable);
      if (selectedFramework !== null) readRoots.add(selectedFramework);
      else if (!commandLineTool) pending.push(selected.executable);
    }
    const dependencies = machoDependencies(canonical, executable);
    if (dependencies !== null) {
      for (const dependency of dependencies) {
        readFiles.add(dependency);
        readFiles.add(realpathSync(dependency));
        pending.push(dependency);
      }
      continue;
    }
  }
  return { readFiles: [...readFiles], readRoots: [...readRoots], readMetadata: [...readMetadata] };
}

function resolveExecutable(command) {
  const resolved = resolveExecutablePath(command, process.env.PATH ?? '');
  const candidate = resolved.invokedPath;
  const runtimeBin = dirname(candidate);
  const searchPath = [...new Set([runtimeBin, ...RUNTIME_PATH])].join(':');
  const interpreters = scriptInterpreters(resolved.executable, searchPath);
  const interpreter = interpreters.at(-1);
  const selectedInterpreter = interpreter === undefined ? null : selectedDeveloperTool(interpreter.executable);
  const interpreterBin = selectedInterpreter === null
    ? (interpreter === undefined ? null : dirname(interpreter.invokedPath))
    : dirname(selectedInterpreter.invokedPath);
  return {
    ...resolved,
    runtimeBin,
    launchExecutable: selectedInterpreter?.executable ?? interpreter?.executable ?? resolved.executable,
    launchArguments: interpreter === undefined ? [] : [resolved.executable],
    runtimePath: [...new Set([runtimeBin, interpreterBin, ...RUNTIME_PATH].filter(Boolean))].join(':'),
    runtimeAccess: runtimeAccess({ ...resolved, runtimeBin }),
  };
}

function mergeRuntimeAccess(...closures) {
  return {
    readFiles: [...new Set(closures.flatMap((closure) => closure.readFiles ?? []))],
    readRoots: [...new Set(closures.flatMap((closure) => closure.readRoots ?? []))],
    readMetadata: [...new Set(closures.flatMap((closure) => closure.readMetadata ?? []))],
  };
}

function metadataAncestors(path) {
  const ancestors = [];
  let current = dirname(path);
  while (current !== dirname(current)) {
    ancestors.push(current);
    current = dirname(current);
  }
  return ancestors;
}

function safeGitConfig(path) {
  if (!existsSync(path)) return false;
  const raw = readFileSync(path);
  if (raw.byteLength > 1024 * 1024) return false;
  const text = raw.toString('utf8');
  return !/^\s*\[(?:include|includeIf)\b/im.test(text)
    && !/https?:\/\/[^/\s:@]+:[^@\s]+@/i.test(text)
    && !/\b(?:ghp_|github_pat_|sk-)[A-Za-z0-9_-]{20,}\b/.test(text)
    && !/^\s*(?:password|token|secret)\s*=/im.test(text);
}

function gitMetadataAccess(readRoots) {
  const readFiles = new Set();
  const metadataRoots = new Set();
  const readMetadata = new Set();
  for (const root of readRoots) {
    let gitDir;
    let commonDir;
    try {
      gitDir = execFileSync('/usr/bin/git', ['-C', root, 'rev-parse', '--absolute-git-dir'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      commonDir = execFileSync(
        '/usr/bin/git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim();
    } catch {
      continue;
    }
    if (!isAbsolute(gitDir) || !isAbsolute(commonDir)) continue;
    if (existsSync(gitDir)) {
      const canonicalGitDir = realpathSync(gitDir);
      metadataRoots.add(canonicalGitDir);
      metadataAncestors(canonicalGitDir).forEach((path) => readMetadata.add(path));
    }
    for (const name of ['objects', 'refs', 'logs', 'info']) {
      const path = join(commonDir, name);
      if (existsSync(path)) {
        const canonicalPath = realpathSync(path);
        metadataRoots.add(canonicalPath);
        metadataAncestors(canonicalPath).forEach((ancestor) => readMetadata.add(ancestor));
      }
    }
    for (const name of ['HEAD', 'packed-refs', 'shallow']) {
      const path = join(commonDir, name);
      if (existsSync(path)) readFiles.add(path);
    }
    for (const path of [join(commonDir, 'config'), join(gitDir, 'config.worktree')]) {
      if (safeGitConfig(path)) readFiles.add(path);
    }
  }
  return {
    readFiles: [...readFiles], readRoots: [...metadataRoots], readMetadata: [...readMetadata],
  };
}

function verifierRuntimeAccess(resolved, readRoots) {
  const launcherClosures = [resolveExecutable('/bin/sh').runtimeAccess];
  if (existsSync(DARWIN_SHELL_SELECTOR)) {
    launcherClosures.push(resolveExecutable(DARWIN_SHELL_SELECTOR).runtimeAccess);
  }
  const auxiliaryClosures = [];
  for (const command of AUXILIARY_TOOL_COMMANDS) {
    try {
      auxiliaryClosures.push(resolveExecutable(command).runtimeAccess);
    } catch { /* an unavailable optional tool remains unavailable inside the verifier */ }
  }
  return mergeRuntimeAccess(
    resolved.runtimeAccess,
    ...launcherClosures,
    ...auxiliaryClosures,
    gitMetadataAccess(readRoots),
  );
}

function processLimit() {
  try {
    const uid = String(process.getuid());
    const userProcesses = execFileSync('/bin/ps', ['-axo', 'uid='], { encoding: 'utf8' })
      .split('\n').filter((value) => value.trim() === uid).length;
    const hard = Number(execFileSync('/bin/sh', ['-c', 'ulimit -Hu'], { encoding: 'utf8' }).trim());
    if (Number.isSafeInteger(hard) && hard > 0) {
      return Math.min(hard, Math.max(64, userProcesses + PROCESS_HEADROOM));
    }
  } catch { /* conservative fixed ceiling below */ }
  return 1024;
}

function discoverSwiftBuildState(readRoots) {
  const candidates = [];
  const pending = readRoots.map((root) => ({ depth: 0, path: root }));
  let visited = 0;
  while (pending.length > 0) {
    const { depth, path } = pending.shift();
    visited += 1;
    if (visited > 10_000) {
      throw verificationError('VERIFIER_RUNTIME_STAGING_LIMIT', 'authorized root traversal is too large');
    }
    let entries;
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch { continue; }
    const names = new Set(entries.map((entry) => entry.name));
    if (names.has('Package.swift') && names.has('.build')) candidates.push(join(path, '.build'));
    if (depth >= 8) continue;
    for (const entry of entries) {
      if (!entry.isDirectory() || ['.build', '.git', '.venv', 'node_modules'].includes(entry.name)) continue;
      pending.push({ depth: depth + 1, path: join(path, entry.name) });
    }
  }
  if (candidates.length > 1) {
    throw verificationError('VERIFIER_RUNTIME_STAGING_AMBIGUOUS', 'multiple Swift build states are in scope');
  }
  return candidates[0] ?? null;
}

function stageSwiftBuildState({ verifier, readRoots, temporaryRoot }) {
  const mayInvokeSwift = verifier.argv.includes('pytest') || basename(verifier.argv[0]) === 'swift';
  if (!mayInvokeSwift) return join(temporaryRoot, 'swift-build');
  const source = discoverSwiftBuildState(readRoots);
  const destination = join(temporaryRoot, 'swift-build');
  if (source !== null) {
    mkdirSync(destination);
    for (const name of ['artifacts', 'checkouts', 'prebuilts', 'repositories', 'workspace-state.json']) {
      const sourcePath = join(source, name);
      if (!existsSync(sourcePath)) continue;
      cpSync(sourcePath, join(destination, name), {
        recursive: true,
        verbatimSymlinks: true,
        mode: constants.COPYFILE_FICLONE,
      });
    }
  }
  return destination;
}

function controlledWriteRoots(verifier, readRoots) {
  if (!verifier.argv.includes('pytest')) return [];
  return readRoots.map((root) => join(root, TRUST_QUALIFICATION_RELATIVE))
    .filter((root) => TRUST_QUALIFICATION_FILES.every((name) => existsSync(join(root, name))));
}

function controlledWriteSnapshot(roots) {
  return JSON.stringify(roots.map((root) => ({
    root: realpathSync(root),
    files: readdirSync(root).sort().map((name) => {
      const path = join(root, name);
      const stat = lstatSync(path);
      if (stat.isFile()) {
        return {
          bytes: readFileSync(path).toString('base64'),
          kind: 'file',
          executable_mode: stat.mode & 0o111,
          name,
        };
      }
      if (stat.isSymbolicLink()) return { kind: 'symlink', name, target: readlinkSync(path) };
      return { executable_mode: stat.mode & 0o111, kind: 'other', name };
    }),
  })));
}

export function verifierProfile({ readRoots, runtimeAccess: access, temporaryRoot, writableRoots = [] }) {
  const canonicalTemporaryRoot = realpathSync(temporaryRoot);
  const canonicalRoots = [...new Set(readRoots.map((root) => realpathSync(root)))].sort();
  const allowedReadRoots = [...new Set([
    ...SYSTEM_RUNTIME_READ_ROOTS,
    ...OPTIONAL_RUNTIME_READ_ROOTS.filter((root) => existsSync(root)),
    ...OPTIONAL_RUNTIME_READ_ROOTS.filter((root) => existsSync(root)).map((root) => realpathSync(root)),
    ...access.readRoots.map((root) => realpathSync(root)),
    ...canonicalRoots,
    temporaryRoot,
    canonicalTemporaryRoot,
  ])].sort();
  const allowedReadFiles = [...new Set(access.readFiles)].sort();
  const allowedReadMetadata = [...new Set([
    ...(access.readMetadata ?? []),
    ...[...allowedReadRoots, ...allowedReadFiles].flatMap((path) => metadataAncestors(path)),
  ])].sort();
  const readFilters = [
    ...allowedReadFiles.map((path) => `(literal ${seatbeltLiteral(path)})`),
    ...allowedReadRoots.map((root) => `(subpath ${seatbeltLiteral(root)})`),
  ];
  return [
    '(version 1)',
    '(deny default)',
    '(deny sysctl-read)',
    '(allow sysctl-read (sysctl-name-prefix "hw."))',
    '(allow sysctl-read (sysctl-name-prefix "kern."))',
    '(deny sysctl-read (sysctl-name-prefix "kern.proc"))',
    '(deny process-info*)',
    '(allow process-info-pidinfo (target self))',
    '(allow signal (target same-sandbox))',
    '(import "dyld-support.sb")',
    '(allow process-exec)',
    '(allow process-fork)',
    `(allow file-read* file-test-existence file-map-executable ${readFilters.join(' ')})`,
    `(allow file-read-metadata file-test-existence (literal "/") (literal "/etc") (literal "/tmp") (literal "/var") ${allowedReadMetadata.map((path) => `(literal ${seatbeltLiteral(path)})`).join(' ')})`,
    '(allow file-read* file-test-existence (literal "/dev/random") (literal "/dev/urandom"))',
    '(allow file-read-data file-test-existence file-write-data (subpath "/dev/fd") (literal "/dev/null") (literal "/dev/zero"))',
    `(allow file-write* (subpath ${seatbeltLiteral(temporaryRoot)}) (subpath ${seatbeltLiteral(canonicalTemporaryRoot)}) ${writableRoots.map((root) => `(subpath ${seatbeltLiteral(realpathSync(root))})`).join(' ')})`,
  ].join('\n');
}

function processTree(rootPid) {
  if (!Number.isSafeInteger(rootPid)) return [];
  const children = new Map();
  try {
    const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' })
      .trim().split('\n').map((line) => line.trim().split(/\s+/).map(Number));
    for (const [pid, parent] of rows) {
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(pid);
    }
  } catch {
    return [rootPid];
  }
  const pids = [];
  const pending = [rootPid];
  while (pending.length > 0) {
    const pid = pending.shift();
    if (pids.includes(pid)) continue;
    pids.push(pid);
    pending.push(...(children.get(pid) ?? []));
  }
  return pids;
}

function terminateProcessTree(child) {
  if (!Number.isSafeInteger(child.pid)) return [];
  const pids = processTree(child.pid);
  for (const pid of [...pids].reverse()) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  return pids;
}

async function waitForProcessExit(pids, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const live = pids.filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if (error.code === 'ESRCH') return false;
        throw error;
      }
    });
    if (live.length === 0) return;
    for (const pid of live) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
    await new Promise((resolveWait) => { setTimeout(resolveWait, 10); });
  }
}

export function runCommandVerifier({ verifier, readRoots, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    if (process.platform !== 'darwin' || !Array.isArray(readRoots) || readRoots.length === 0) {
      resolve({
        code: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from('verifier-isolation-unavailable'),
        timed_out: false,
      });
      return;
    }
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'goal-condition-verifier-'));
    let resolved;
    let swiftBuildRoot;
    let writableRoots;
    let writeSnapshot;
    try {
      resolved = resolveExecutable(verifier.argv[0]);
      swiftBuildRoot = stageSwiftBuildState({ verifier, readRoots, temporaryRoot });
      writableRoots = controlledWriteRoots(verifier, readRoots);
      writeSnapshot = controlledWriteSnapshot(writableRoots);
    } catch (error) {
      rmSync(temporaryRoot, { recursive: true, force: true });
      resolve({
        code: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.from(error.code ?? 'verifier-executable-unavailable'),
        timed_out: false,
      });
      return;
    }
    const subtreeProcessLimit = processLimit();
    const resourceWrapper = [
      'ulimit -t 60',
      'ulimit -n 128',
      'ulimit -f 32768',
      'ulimit -u "$1"',
      'shift',
      'exec "$@"',
    ].join('; ');
    const child = spawn('/usr/bin/sandbox-exec', [
      '-p', verifierProfile({
        readRoots,
        runtimeAccess: verifierRuntimeAccess(resolved, readRoots),
        temporaryRoot,
        writableRoots,
      }),
      '/bin/sh', '-c', resourceWrapper, 'goal-condition-verifier', String(subtreeProcessLimit),
      resolved.launchExecutable, ...resolved.launchArguments, ...verifier.argv.slice(1),
    ], {
      cwd: verifier.cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env: {
        HOME: temporaryRoot,
        TMPDIR: temporaryRoot,
        SWIFTPM_BUILD_DIR: swiftBuildRoot,
        CLANG_MODULE_CACHE_PATH: join(temporaryRoot, 'swift-module-cache'),
        SWIFTPM_MODULECACHE_OVERRIDE: join(temporaryRoot, 'swift-module-cache'),
        PATH: resolved.runtimePath,
        LANG: 'C',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.precomposeunicode',
        GIT_CONFIG_VALUE_0: 'false',
        GIT_TERMINAL_PROMPT: '0',
        ...(existsSync(COMMAND_LINE_TOOLS) ? { DEVELOPER_DIR: COMMAND_LINE_TOOLS } : {}),
      },
    });
    const stdout = [];
    const stderr = [];
    let size = 0;
    const collect = (target) => (chunk) => {
      if (size >= OUTPUT_LIMIT) return;
      const remaining = OUTPUT_LIMIT - size;
      const next = Buffer.from(chunk).subarray(0, remaining);
      size += next.byteLength;
      target.push(next);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    let timedOut = false;
    let spawnError = null;
    let settled = false;
    let terminatedPids = [];
    const finish = async (code, errorBytes = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) await waitForProcessExit(terminatedPids);
      let finalCode = code;
      let finalError = errorBytes;
      try {
        if (controlledWriteSnapshot(writableRoots) !== writeSnapshot) {
          finalCode = null;
          finalError = Buffer.from('VERIFIER_CONTROLLED_WRITE_DRIFT');
        }
      } catch {
        finalCode = null;
        finalError = Buffer.from('VERIFIER_CONTROLLED_WRITE_DRIFT');
      }
      rmSync(temporaryRoot, { recursive: true, force: true });
      resolve({
        code: finalCode,
        stdout: bounded(stdout),
        stderr: finalError ?? bounded(stderr),
        timed_out: timedOut,
      });
    };
    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      terminatedPids = terminateProcessTree(child);
    }, timeoutMs);
    child.on('error', (error) => {
      spawnError = Buffer.from(error.code ?? 'spawn-error');
      void finish(null, spawnError);
    });
    child.on('close', (code) => {
      void finish(timedOut ? null : code, spawnError);
    });
  });
}

export async function verifyConditions({
  session, attemptId, runtimeVersionHash, projectionHash, snapshotHash,
  now = new Date().toISOString(), runner = runCommandVerifier, bypasses = [],
}) {
  const design = session.design_revisions.at(-1);
  const roots = design.active_boundary.target_roots;
  const evidence = [];
  const currentInputsByCondition = {};
  for (let index = 0; index < design.conditions.length; index += 1) {
    const condition = design.conditions[index];
    if (!roots.some((root) => inside(root, condition.verifier.cwd))) {
      throw verificationError('VERIFIER_CWD_OUTSIDE_AUTHORITY', 'verifier cwd is outside active target roots');
    }
    const result = await runner({ verifier: condition.verifier, readRoots: roots });
    const output = Buffer.concat([
      Buffer.from(result.stdout ?? Buffer.alloc(0)),
      Buffer.from(result.stderr ?? Buffer.alloc(0)),
    ]).subarray(0, OUTPUT_LIMIT);
    const inputHashes = [
      { kind: 'runtime', id: 'codex-runtime', sha256: runtimeVersionHash },
      { kind: 'projection', id: attemptId, sha256: projectionHash },
      { kind: 'snapshot', id: attemptId, sha256: snapshotHash },
    ];
    currentInputsByCondition[condition.id] = inputHashes;
    evidence.push(recordEvidence({
      evidenceId: `evidence-${attemptId}-${index + 1}`,
      condition,
      attemptId,
      inputHashes: [
        { kind: 'root_baseline', id: session.session_id, sha256: session.root_baseline_hash },
        ...design.context_dependencies.map((dependency) => ({
          kind: 'context', id: dependency.id, sha256: dependency.sha256,
        })),
        ...inputHashes,
      ],
      result: result.code === 0 && result.timed_out !== true ? 'pass' : 'fail',
      outputBytes: output,
      capturedAt: now,
      expiresAt: null,
      controllerOwned: true,
    }));
  }
  return {
    evidence,
    completion: completionLevel({
      session,
      evidence,
      bypasses,
      currentInputsByCondition,
      now,
    }),
  };
}
