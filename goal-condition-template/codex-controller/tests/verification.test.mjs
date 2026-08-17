import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { compileDraft } from '../src/compiler.mjs';
import { runCommandVerifier, verifyConditions } from '../src/verification.mjs';
import { validDraft } from './helpers.mjs';

test('controller verifier hashes bounded output and can certify a clean Attempt', async () => {
  const { session } = compileDraft(validDraft());
  const result = await verifyConditions({
    session,
    attemptId: 'attempt-0001',
    runtimeVersionHash: 'b'.repeat(64),
    projectionHash: 'c'.repeat(64),
    snapshotHash: 'd'.repeat(64),
    now: '2026-08-11T00:00:00.000Z',
    runner: async () => ({ code: 0, stdout: Buffer.from('pass\n'), stderr: Buffer.alloc(0) }),
    bypasses: [],
  });
  assert.equal(result.completion.level, 'certified');
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0].output_hash.length, 64);
  assert.equal(result.evidence[0].stdout, undefined);
  assert.equal(result.evidence[0].output_bytes, undefined);
});

test('a bypass caps completion at Verified even when all verifiers pass', async () => {
  const { session } = compileDraft(validDraft());
  const result = await verifyConditions({
    session,
    attemptId: 'attempt-0001',
    runtimeVersionHash: 'b'.repeat(64),
    projectionHash: 'c'.repeat(64),
    snapshotHash: 'd'.repeat(64),
    now: '2026-08-11T00:00:00.000Z',
    runner: async () => ({ code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }),
    bypasses: [{ type: 'CONTROL_PLANE_BYPASS' }],
  });
  assert.equal(result.completion.level, 'verified');
  assert.deepEqual(result.completion.reason_codes, ['CONTROL_PLANE_BYPASS']);
});

test('command verifier admits the controller launcher shell closure for a script verifier', async (t) => {
  if (process.platform !== 'darwin') return t.skip('Seatbelt verifier isolation is macOS-specific');
  const base = mkdtempSync(join(homedir(), '.goal-condition-verifier-test-'));
  const root = join(base, 'target');
  const verifier = join(root, 'verify.py');
  mkdirSync(root);
  writeFileSync(
    verifier,
    '#!/usr/bin/env python3\nimport subprocess\nsubprocess.run(["git", "--version"], check=True)\nprint("verified")\n',
    { mode: 0o755 },
  );
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const result = await runCommandVerifier({
    verifier: { cwd: root, argv: [verifier] },
    readRoots: [root],
  });

  assert.equal(result.code, 0, result.stderr.toString());
  assert.match(result.stdout.toString(), /^git version .+\nverified\n$/);
});

test('command verifier admits read-only Git worktree metadata closure', async (t) => {
  if (process.platform !== 'darwin') return t.skip('Seatbelt verifier isolation is macOS-specific');
  const base = mkdtempSync(join(homedir(), '.goal-condition-git-closure-test-'));
  const source = join(base, 'source');
  const root = join(base, 'target');
  mkdirSync(source);
  execFileSync('/usr/bin/git', ['init', '-q', source]);
  execFileSync('/usr/bin/git', ['-C', source, 'config', 'core.precomposeunicode', 'true']);
  const verifier = join(source, 'verify.py');
  writeFileSync(
    verifier,
    '#!/usr/bin/env python3\nimport subprocess\nsubprocess.run(["git", "config", "--bool", "core.precomposeunicode"], check=True)\nsubprocess.run(["git", "rev-parse", "HEAD"], check=True)\nsubprocess.run(["git", "status", "--porcelain=v1"], check=True)\n',
    { mode: 0o755 },
  );
  execFileSync('/usr/bin/git', ['-C', source, 'add', 'verify.py']);
  execFileSync('/usr/bin/git', [
    '-C', source, '-c', 'user.name=Goal Condition', '-c', 'user.email=goal-condition@example.invalid',
    'commit', '-qm', 'fixture',
  ]);
  execFileSync('/usr/bin/git', ['-C', source, 'worktree', 'add', '-q', root]);
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const result = await runCommandVerifier({
    verifier: { cwd: root, argv: [join(root, 'verify.py')] },
    readRoots: [root],
  });

  assert.equal(result.code, 0, result.stderr.toString());
  assert.match(result.stdout.toString(), /^false\n[0-9a-f]{40}\n$/);
});

test('command verifier can read authorized roots but not sibling controller or user files', async (t) => {
  if (process.platform !== 'darwin') return t.skip('Seatbelt verifier isolation is macOS-specific');
  const base = mkdtempSync(join(homedir(), '.goal-condition-verifier-test-'));
  const root = join(base, 'target');
  const secret = join(base, 'controller-secret');
  const external = mkdtempSync(join('/private/tmp', 'goal-condition-verifier-secret-'));
  const externalSecret = join(external, 'secret');
  mkdirSync(root);
  writeFileSync(join(root, 'allowed.txt'), 'allowed');
  writeFileSync(secret, 'secret');
  writeFileSync(externalSecret, 'secret');
  t.after(() => rmSync(base, { recursive: true, force: true }));
  t.after(() => rmSync(external, { recursive: true, force: true }));

  const allowed = await runCommandVerifier({
    verifier: { cwd: root, argv: ['/bin/cat', join(root, 'allowed.txt')] },
    readRoots: [root],
  });
  assert.equal(allowed.code, 0);
  assert.equal(allowed.stdout.toString(), 'allowed');

  const denied = await runCommandVerifier({
    verifier: { cwd: root, argv: ['/bin/cat', secret] },
    readRoots: [root],
  });
  assert.notEqual(denied.code, 0);
  assert.equal(denied.timed_out, false);

  const externalDenied = await runCommandVerifier({
    verifier: { cwd: root, argv: ['/bin/cat', externalSecret] },
    readRoots: [root],
  });
  assert.notEqual(externalDenied.code, 0);

  const systemDenied = await runCommandVerifier({
    verifier: { cwd: root, argv: ['/bin/cat', '/etc/hosts'] },
    readRoots: [root],
  });
  assert.notEqual(systemDenied.code, 0);

  const homebrewHostFiles = [
    '/opt/homebrew/etc/redis.conf',
    '/opt/homebrew/var/postgresql@16/postgresql.auto.conf',
    '/usr/local/etc/redis.conf',
    '/usr/local/var/postgresql/postgresql.auto.conf',
  ].filter((path) => existsSync(path));
  for (const path of homebrewHostFiles) {
    const hostFileDenied = await runCommandVerifier({
      verifier: { cwd: root, argv: ['/bin/cat', path] },
      readRoots: [root],
    });
    assert.notEqual(hostFileDenied.code, 0, `host service data must stay unreadable: ${path}`);
  }
});

test('command verifier cannot inspect or signal sibling host processes', async (t) => {
  if (process.platform !== 'darwin') return t.skip('Seatbelt verifier isolation is macOS-specific');
  const base = mkdtempSync(join(homedir(), '.goal-condition-verifier-test-'));
  const root = join(base, 'target');
  mkdirSync(root);
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const victim = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
  await new Promise((resolve, reject) => {
    victim.once('spawn', resolve);
    victim.once('error', reject);
  });
  t.after(() => {
    try { victim.kill('SIGKILL'); } catch { /* already gone */ }
  });

  const signal = await runCommandVerifier({
    verifier: { cwd: root, argv: ['/bin/kill', '-TERM', String(victim.pid)] },
    readRoots: [root],
  });
  assert.notEqual(signal.code, 0);
  assert.equal(victim.exitCode, null);
  assert.equal(victim.signalCode, null);

  const inspect = await runCommandVerifier({
    verifier: { cwd: root, argv: ['/bin/ps', '-p', String(victim.pid)] },
    readRoots: [root],
  });
  assert.notEqual(inspect.code, 0);
});

test('command verifier cannot inspect host process arguments through sysctl', async (t) => {
  if (process.platform !== 'darwin') return t.skip('Seatbelt verifier isolation is macOS-specific');
  const base = mkdtempSync(join(homedir(), '.goal-condition-verifier-test-'));
  const root = join(base, 'target');
  const source = join(root, 'inspect.c');
  const binary = join(root, 'inspect');
  mkdirSync(root);
  writeFileSync(source, `
#include <sys/types.h>
#include <sys/sysctl.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
int main(int argc, char **argv) {
  if (argc != 2) return 2;
  int mib[3] = { CTL_KERN, KERN_PROCARGS2, atoi(argv[1]) };
  size_t size = 0;
  if (sysctl(mib, 3, NULL, &size, NULL, 0) != 0) return 3;
  char *buffer = malloc(size);
  if (buffer == NULL) return 4;
  if (sysctl(mib, 3, buffer, &size, NULL, 0) != 0) return 5;
  fwrite(buffer, 1, size, stdout);
  free(buffer);
  return 0;
}
`);
  execFileSync('/usr/bin/clang', [source, '-o', binary]);
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const result = await runCommandVerifier({
    verifier: { cwd: root, argv: [binary, String(process.pid)] },
    readRoots: [root],
  });
  assert.notEqual(result.code, 0);
});

test('command verifier installs a bounded process limit for its complete subtree', async (t) => {
  if (process.platform !== 'darwin') return t.skip('Seatbelt verifier isolation is macOS-specific');
  const base = mkdtempSync(join(homedir(), '.goal-condition-verifier-test-'));
  const root = join(base, 'target');
  mkdirSync(root);
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const result = await runCommandVerifier({
    verifier: { cwd: root, argv: ['/bin/sh', '-c', 'ulimit -u'] },
    readRoots: [root],
  });
  assert.equal(result.code, 0);
  const processLimit = Number(result.stdout.toString().trim());
  assert.equal(Number.isSafeInteger(processLimit), true);
  assert.equal(processLimit > 0, true);
  assert.equal(processLimit < 2666, true);
});

test('command verifier receives a minimal environment and cannot write to target roots', async (t) => {
  if (process.platform !== 'darwin') return t.skip('Seatbelt verifier isolation is macOS-specific');
  const base = mkdtempSync(join(homedir(), '.goal-condition-verifier-test-'));
  const root = join(base, 'target');
  mkdirSync(root);
  t.after(() => rmSync(base, { recursive: true, force: true }));
  process.env.GOAL_CONDITION_VERIFIER_SECRET = 'must-not-leak';
  t.after(() => { delete process.env.GOAL_CONDITION_VERIFIER_SECRET; });

  const environment = await runCommandVerifier({
    verifier: { cwd: root, argv: ['/bin/sh', '-c', 'test -z "$GOAL_CONDITION_VERIFIER_SECRET"'] },
    readRoots: [root],
  });
  assert.equal(environment.code, 0);

  const output = join(root, 'forbidden.txt');
  const write = await runCommandVerifier({
    verifier: { cwd: root, argv: ['/bin/sh', '-c', `echo forbidden > ${JSON.stringify(output)}`] },
    readRoots: [root],
  });
  assert.notEqual(write.code, 0);
  assert.equal(existsSync(output), false);
});

test('command verifier timeout kills the complete verifier process group before returning', async (t) => {
  if (process.platform !== 'darwin') return t.skip('Seatbelt verifier isolation is macOS-specific');
  const base = mkdtempSync(join(homedir(), '.goal-condition-verifier-test-'));
  const root = join(base, 'target');
  const source = join(root, 'timeout.c');
  const binary = join(root, 'timeout');
  mkdirSync(root);
  writeFileSync(source, `
#include <sys/types.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
int main(void) {
  pid_t child = fork();
  if (child < 0) return 2;
  if (child == 0) { for (;;) pause(); }
  printf("%d\\n", child);
  fflush(stdout);
  for (;;) pause();
}
`);
  execFileSync('/usr/bin/clang', [source, '-o', binary]);
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const result = await runCommandVerifier({
    verifier: { cwd: root, argv: [binary] },
    readRoots: [root],
    timeoutMs: 100,
  });
  assert.equal(result.timed_out, true);
  const childPid = Number(result.stdout.toString().trim());
  assert.equal(Number.isSafeInteger(childPid), true);
  let survivingCommand = '';
  try {
    survivingCommand = execFileSync('/bin/ps', ['-p', String(childPid), '-o', 'command='], {
      encoding: 'utf8',
    }).trim();
  } catch { /* the PID no longer exists */ }
  assert.equal(survivingCommand.includes(binary), false);
});
