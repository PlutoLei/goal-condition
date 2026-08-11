import { spawn } from 'node:child_process';
import { isAbsolute, relative } from 'node:path';

import { completionLevel, recordEvidence } from './evidence.mjs';

const OUTPUT_LIMIT = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;

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

export function runCommandVerifier({ verifier, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    const child = spawn(verifier.argv[0], verifier.argv.slice(1), {
      cwd: verifier.cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
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
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      resolve({ code: null, stdout: bounded(stdout), stderr: bounded(stderr), timed_out: true });
    }, timeoutMs);
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, stdout: bounded(stdout), stderr: Buffer.from(error.code ?? 'spawn-error'), timed_out: false });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: bounded(stdout), stderr: bounded(stderr), timed_out: false });
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
    const result = await runner({ verifier: condition.verifier });
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
