import { execFileSync, spawn } from 'node:child_process';
import {
  accessSync, constants, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { completionLevel, recordEvidence } from './evidence.mjs';

const OUTPUT_LIMIT = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const PROCESS_HEADROOM = 32;
const SYSTEM_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
const SYSTEM_RUNTIME_PREFIXES = ['/System/', '/usr/lib/'];
const SYSTEM_RUNTIME_READ_ROOTS = ['/System', '/usr/lib', '/Library/Apple'];
const HOMEBREW_CELLARS = ['/opt/homebrew/Cellar', '/usr/local/Cellar'];
const MAX_RUNTIME_OBJECTS = 128;

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

function scriptInterpreter(path, searchPath) {
  const firstLine = readFileSync(path).subarray(0, 4096).toString('utf8').split('\n', 1)[0];
  if (!firstLine.startsWith('#!')) return null;
  const words = firstLine.slice(2).trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  if (words[0] === '/usr/bin/env') {
    const command = words[1] === '-S' ? words[2] : words.find((word, index) => index > 0 && !word.startsWith('-'));
    if (!command) return null;
    return resolveExecutablePath(command, searchPath);
  }
  if (!isAbsolute(words[0])) return null;
  return resolveExecutablePath(words[0], searchPath);
}

function runtimeAccess({ invokedPath, executable, runtimeBin }) {
  const readFiles = new Set([invokedPath, executable]);
  const readRoots = new Set();
  const pending = [executable];
  const inspected = new Set();
  const searchPath = [...new Set([runtimeBin, ...SYSTEM_PATH])].join(':');
  while (pending.length > 0) {
    if (inspected.size >= MAX_RUNTIME_OBJECTS) {
      throw verificationError('VERIFIER_RUNTIME_DEPENDENCY_LIMIT', 'verifier runtime dependency graph is too large');
    }
    const next = pending.shift();
    const canonical = realpathSync(next);
    if (inspected.has(canonical) || systemRuntime(canonical)) continue;
    inspected.add(canonical);
    const cellarRoot = cellarVersionRoot(canonical);
    if (cellarRoot === null) readFiles.add(canonical);
    else readRoots.add(cellarRoot);
    const dependencies = machoDependencies(canonical, executable);
    if (dependencies !== null) {
      for (const dependency of dependencies) {
        readFiles.add(dependency);
        readFiles.add(realpathSync(dependency));
        pending.push(dependency);
      }
      continue;
    }
    const interpreter = scriptInterpreter(canonical, searchPath);
    if (interpreter !== null) {
      readFiles.add(interpreter.invokedPath);
      readFiles.add(interpreter.executable);
      pending.push(interpreter.executable);
    }
  }
  return { readFiles: [...readFiles], readRoots: [...readRoots] };
}

function resolveExecutable(command) {
  const resolved = resolveExecutablePath(command, process.env.PATH ?? '');
  const candidate = resolved.invokedPath;
  const runtimeBin = dirname(candidate);
  return {
    ...resolved,
    runtimeBin,
    runtimeAccess: runtimeAccess({ ...resolved, runtimeBin }),
  };
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

export function verifierProfile({ readRoots, runtimeAccess: access, temporaryRoot }) {
  const canonicalRoots = [...new Set(readRoots.map((root) => realpathSync(root)))].sort();
  const allowedReadRoots = [...new Set([
    ...SYSTEM_RUNTIME_READ_ROOTS,
    ...access.readRoots.map((root) => realpathSync(root)),
    ...canonicalRoots,
    temporaryRoot,
  ])].sort();
  const allowedReadFiles = [...new Set(access.readFiles)].sort();
  const readFilters = [
    ...allowedReadFiles.map((path) => `(literal ${seatbeltLiteral(path)})`),
    ...allowedReadRoots.map((root) => `(subpath ${seatbeltLiteral(root)})`),
  ];
  return [
    '(version 1)',
    '(deny default)',
    '(deny sysctl-read)',
    '(deny process-info*)',
    '(import "dyld-support.sb")',
    '(allow process-exec)',
    '(allow process-fork)',
    `(allow file-read* file-test-existence file-map-executable ${readFilters.join(' ')})`,
    '(allow file-read-metadata file-test-existence (literal "/") (literal "/etc") (literal "/tmp") (literal "/var"))',
    '(allow file-read* file-test-existence (literal "/dev/random") (literal "/dev/urandom"))',
    '(allow file-read-data file-test-existence file-write-data (subpath "/dev/fd") (literal "/dev/null") (literal "/dev/zero"))',
    `(allow file-write* (subpath ${seatbeltLiteral(temporaryRoot)}))`,
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
    try {
      resolved = resolveExecutable(verifier.argv[0]);
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
      '-p', verifierProfile({ readRoots, runtimeAccess: resolved.runtimeAccess, temporaryRoot }),
      '/bin/sh', '-c', resourceWrapper, 'goal-condition-verifier', String(subtreeProcessLimit),
      resolved.executable, ...verifier.argv.slice(1),
    ], {
      cwd: verifier.cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env: {
        HOME: temporaryRoot,
        TMPDIR: temporaryRoot,
        PATH: [...new Set([resolved.runtimeBin, ...SYSTEM_PATH])].join(':'),
        LANG: 'C',
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
      rmSync(temporaryRoot, { recursive: true, force: true });
      resolve({
        code,
        stdout: bounded(stdout),
        stderr: errorBytes ?? bounded(stderr),
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
