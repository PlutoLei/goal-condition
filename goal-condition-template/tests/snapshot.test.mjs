import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { deflate as deflateCallback, inflate as inflateCallback } from 'node:zlib';
import { captureSnapshot, compareSnapshot, snapshotDigest } from '../scripts/lib/snapshot.mjs';
import { canonicalJson } from '../scripts/lib/contract.mjs';

const execFile = promisify(execFileCallback);
const deflate = promisify(deflateCallback);
const inflate = promisify(inflateCallback);
const workspaceRoot = process.cwd();
const contextContents = 'stable context\n';
const contextSha256 = createHash('sha256').update(contextContents).digest('hex');
let alternateIndexCounter = 0;

async function git(repo, args, options = {}) {
  return execFile('git', ['-C', repo, ...args], {
    ...options,
    env: options.env ? { ...process.env, ...options.env } : undefined,
  });
}

async function writeGitBlob(repo, contents, label) {
  const temporary = join(repo, '.git', `.round2-${label}-${process.pid}`);
  await writeFile(temporary, contents);
  try {
    return (await git(repo, ['hash-object', '-w', '--no-filters', temporary])).stdout.trim();
  } finally {
    await rm(temporary, { force: true });
  }
}

async function createTreeOnlyCommit(repo, baselineEntry, {
  pathname, mode, object, remove = false, message,
}) {
  alternateIndexCounter += 1;
  const alternateIndex = join(repo, '.git', `.round2-index-${process.pid}-${alternateIndexCounter}`);
  const env = { GIT_INDEX_FILE: alternateIndex };
  let tree;
  try {
    await git(repo, ['read-tree', baselineEntry.head], { env });
    if (remove) {
      await git(repo, ['update-index', '--force-remove', pathname], { env });
    } else {
      await git(repo, ['update-index', '--add', '--cacheinfo', `${mode},${object},${pathname}`], { env });
    }
    tree = (await git(repo, ['write-tree'], { env })).stdout.trim();
  } finally {
    await rm(alternateIndex, { force: true });
  }
  const child = (await git(repo, [
    'commit-tree', tree, '-p', baselineEntry.head, '-m', message,
  ])).stdout.trim();
  await git(repo, ['update-ref', 'refs/heads/codex/test-snapshot', child]);
  return child;
}

async function createRepository(t) {
  const repo = await mkdtemp(join(workspaceRoot, '.snapshot-test-'));
  t.after(() => rm(repo, { recursive: true, force: true }));
  await git(repo, ['init', '--initial-branch=codex/test-snapshot']);
  await git(repo, ['config', 'user.name', 'Snapshot Test']);
  await git(repo, ['config', 'user.email', 'snapshot-test@example.invalid']);
  await writeFile(join(repo, 'tracked.txt'), 'original\n');
  await writeFile(join(repo, 'protected.txt'), 'protected\n');
  await writeFile(join(repo, 'context.md'), contextContents);
  await git(repo, ['add', 'tracked.txt', 'protected.txt', 'context.md']);
  await git(repo, ['commit', '-m', 'initial']);
  await writeFile(join(repo, 'dirty-before.txt'), 'pre-existing dirty state\n');
  return repo;
}

function contractFor(repo, overrides = {}) {
  return {
    version: 1,
    runtime: 'codex',
    objective: 'Capture a local Git baseline without launching a runtime.',
    context_sources: [{ id: 'CTX1', path: join(repo, 'context.md'), sha256: contextSha256 }],
    target_roots: [repo],
    judgment_criteria: [{ id: 'J1', rule: 'Only declared changes are accepted.', why: 'Boundary changes must be auditable.' }],
    success_criteria: [{ id: 'S1', command: 'Snapshot comparison returns ok.', expected: 'No undeclared changes.' }],
    constraints: [],
    allowed_mutations: {
      files: [join(repo, 'tracked.txt')],
      git: ['commit'],
      external: [],
    },
    preflight: [{
      id: 'G1', type: 'git', target: repo, require_branch: 'codex/test-snapshot', require_clean: false,
    }],
    postflight: [{
      id: 'V1', type: 'command', cwd: repo, argv: ['node', '--version'], capture: 'hash',
    }],
    ...overrides,
  };
}

function hasViolation(result, code, entry = undefined) {
  return result.violations.some((violation) => violation.code === code
    && (entry === undefined || violation.entry === entry));
}

function safeEffectiveTreeItem(item) {
  return typeof item.path === 'string'
    && ['file', 'symlink', 'missing', 'gitlink', 'other'].includes(item.type);
}

function treeObject(output, pathname) {
  const record = output.split('\0').find((item) => item.endsWith(`\t${pathname}`));
  assert.ok(record, `missing tree entry for ${pathname}`);
  const match = record.match(/^[0-7]{6} blob ([0-9a-f]{40,64})\t/);
  assert.ok(match, `malformed tree entry for ${pathname}`);
  return match[1];
}

function compareTrusted(contract, baseline, current) {
  return compareSnapshot(contract, baseline, current, {
    expectedBaselineDigest: snapshotDigest(baseline),
  });
}

function baselineGitHeads(snapshot) {
  return Object.fromEntries(snapshot.entries
    .filter((entry) => entry.type === 'git')
    .map((entry) => [entry.id, entry.head]));
}

// phase 必填。测试里绝大多数调用都是 capture 阶段，包一层免得每处重复；verify 阶段走 captureAgainst，
// 两个包装各自把阶段写死，用例里就不存在「忘了传」这种与被测语义无关的失败。
function captureBaseline(contract) {
  return captureSnapshot(contract, { phase: 'capture' });
}

async function captureAgainst(contract, baseline) {
  return captureSnapshot(contract, { baselineGitHeads: baselineGitHeads(baseline), phase: 'verify' });
}

async function diagnosticFrom(promise, code) {
  try {
    await promise;
  } catch (error) {
    return error.diagnostics?.find((item) => item.code === code);
  }
  return undefined;
}

test('records a Git baseline with null upstream and preserves pre-existing dirty state', async (t) => {
  const repo = await createRepository(t);
  const contract = contractFor(repo);

  const baseline = await captureBaseline(contract);
  const gitEntry = baseline.entries.find((entry) => entry.id === 'G1');

  assert.match(gitEntry.head, /^[0-9a-f]{40}$/);
  assert.equal(gitEntry.branch, 'codex/test-snapshot');
  assert.equal(gitEntry.upstream, null);
  assert.deepEqual(gitEntry.porcelain, [{ code: '??', path: 'dirty-before.txt' }]);
  assert.equal(typeof gitEntry.refs, 'object');
  assert.match(gitEntry.refs['refs/heads/codex/test-snapshot'], /^[0-9a-f]{40}$/);
  assert.deepEqual(gitEntry.ancestry, {
    baseline_head: gitEntry.head,
    current_head: gitEntry.head,
    is_ancestor: true,
  });
  assert.deepEqual(gitEntry.history, {
    grafts: 'absent', shallow: false, replace_objects_ignored: true,
  });
  assert.equal(gitEntry.tree.every((item) => item.type !== 'blob' || /^[0-9a-f]{64}$/.test(item.bytes_sha256)), true);
  assert.equal(gitEntry.effective_tree.every((item) => safeEffectiveTreeItem(item)), true);

  const current = await captureAgainst(contract, baseline);
  assert.deepEqual(compareTrusted(contract, baseline, current), {
    ok: true,
    changes: [],
    violations: [],
  });
});

test('streams committed blob SHA-256 material beyond the former child-process buffer limit', async (t) => {
  const repo = await createRepository(t);
  const bytes = Buffer.alloc((17 * 1024 * 1024) + 1, 0x61);
  await writeFile(join(repo, 'large.bin'), bytes);
  await git(repo, ['add', 'large.bin']);
  await git(repo, ['commit', '-m', 'large committed blob']);

  const snapshot = await captureBaseline(contractFor(repo));
  const treeEntry = snapshot.entries.find((entry) => entry.id === 'G1').tree
    .find((entry) => entry.path === 'large.bin');
  assert.equal(treeEntry.bytes_sha256, createHash('sha256').update(bytes).digest('hex'));
});

test('binds every context file into the trusted baseline even when file mutations allow it', async (t) => {
  const repo = await createRepository(t);
  const contextPath = join(repo, 'context.md');
  const contract = contractFor(repo, {
    allowed_mutations: {
      files: [join(repo, 'tracked.txt'), contextPath],
      git: ['commit'],
      external: [],
    },
  });
  const baseline = await captureBaseline(contract);
  const current = structuredClone(baseline);
  current.contexts[0].mode = current.contexts[0].mode === '0644' ? '0600' : '0644';
  const result = compareSnapshot(contract, baseline, current, {
    expectedBaselineDigest: snapshotDigest(baseline),
  });

  assert.equal(result.ok, false);
  assert.equal(hasViolation(result, 'CONTEXT_STATE_CHANGED', 'CTX1'), true);

  await writeFile(contextPath, 'mutated context\n');
  await assert.rejects(
    captureBaseline(contract),
    (error) => error.diagnostics?.some((item) => item.code === 'CONTEXT_HASH_MISMATCH' && item.entry === 'CTX1'),
  );
});

test('preflight rejects missing, symlink, hash-mismatched, and temporary-alias contexts', async (t) => {
  const repo = await createRepository(t);
  const outside = await mkdtemp(join('/tmp', 'goal-context-alias-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, 'context.md'), contextContents);
  await symlink(outside, join(repo, 'context-alias'), 'dir');

  const cases = [
    ['missing', join(repo, 'missing.md'), contextSha256],
    ['hash', join(repo, 'context.md'), 'f'.repeat(64)],
    ['temporary alias', join(repo, 'context-alias', 'context.md'), contextSha256],
  ];
  await symlink(join(repo, 'context.md'), join(repo, 'context-link.md'));
  cases.push(['symlink', join(repo, 'context-link.md'), contextSha256]);

  for (const [name, path, sha256] of cases) {
    await assert.rejects(
      captureBaseline(contractFor(repo, {
        context_sources: [{ id: 'CTX-race', path, sha256 }],
      })),
      (error) => error.diagnostics?.some((item) => item.entry === 'CTX-race'
        && ['CONTEXT_FILE_INVALID', 'CONTEXT_HASH_MISMATCH', 'CONTEXT_TEMPORARY_PHYSICAL_PATH', 'CONTEXT_ROOT_ESCAPE', 'SYMLINK_ESCAPES_TARGET_ROOT'].includes(item.code)),
      name,
    );
  }
});

test('classifies newly changed allowed files separately from protected files', async (t) => {
  const repo = await createRepository(t);
  const contract = contractFor(repo);
  const baseline = await captureBaseline(contract);

  await writeFile(join(repo, 'tracked.txt'), 'changed allowed\n');
  await writeFile(join(repo, 'protected.txt'), 'changed protected\n');
  const current = await captureBaseline(contract);
  const result = compareTrusted(contract, baseline, current);

  assert.equal(result.ok, false);
  assert.deepEqual(result.changes.map((change) => change.path), [join(repo, 'tracked.txt')]);
  assert.equal(hasViolation(result, 'FILE_MUTATION_NOT_ALLOWED', 'G1'), true);
  assert.equal(result.violations.find((violation) => violation.code === 'FILE_MUTATION_NOT_ALLOWED').observed,
    join(repo, 'protected.txt'));
});

test('requires an upstream only when the Git entry explicitly requests it', async (t) => {
  const repo = await createRepository(t);
  const baseline = await captureBaseline(contractFor(repo));
  assert.equal(baseline.entries.find((entry) => entry.id === 'G1').upstream, null);

  await assert.rejects(
    captureBaseline(contractFor(repo, {
      preflight: [{ id: 'UP1', type: 'git', target: repo, require_upstream: true }],
    })),
    (error) => error.diagnostics?.some((diagnostic) => diagnostic.entry === 'UP1'
      && diagnostic.field === 'require_upstream'
      && diagnostic.observed === 'null'
      && diagnostic.expected === 'configured upstream'),
  );
});

// require_clean / require_branch / require_upstream 是 launch 前置条件，不是 run-long 不变量。
// verify 阶段重跑它们，等于把 preflight 谓词施加到 run 之后的工作树上，而工作树此刻必然脏——脏的
// 正是 allowed_mutations 声明允许的那个产物，于是「产出了正确结果」结构性必红。
test('a declared run product verifies green under require_clean instead of failing structurally', async (t) => {
  const repo = await createRepository(t);
  await rm(join(repo, 'dirty-before.txt'));   // require_clean 需要一个干净起点才能拿到 baseline
  const contract = contractFor(repo, {
    preflight: [{
      id: 'G1', type: 'git', target: repo, require_branch: 'codex/test-snapshot', require_clean: true,
    }],
  });
  const baseline = await captureBaseline(contract);
  await writeFile(join(repo, 'tracked.txt'), 'run product\n');   // allowed_mutations 里声明过的产物

  const result = compareTrusted(contract, baseline, await captureAgainst(contract, baseline));
  assert.deepEqual(result.violations, []);
  assert.equal(result.ok, true);
  assert.deepEqual(result.changes.map((change) => change.path), [join(repo, 'tracked.txt')]);
});

// 上一条只证明 verify 侧放行了，还得证明 capture 侧的谓词没被顺手删掉。
test('capture still refuses a dirty worktree, a wrong branch, and a missing upstream', async (t) => {
  const repo = await createRepository(t);   // dirty-before.txt 让工作树开局就是脏的
  const contract = contractFor(repo, {
    preflight: [{
      id: 'G1', type: 'git', target: repo, require_branch: 'codex/test-snapshot', require_clean: true,
    }],
  });
  const dirty = await diagnosticFrom(captureBaseline(contract), 'GIT_CLEAN_REQUIRED');
  assert.ok(dirty, 'capture must still raise GIT_CLEAN_REQUIRED');
  assert.match(dirty.next, /before capturing the baseline/);

  await rm(join(repo, 'dirty-before.txt'));
  await git(repo, ['checkout', '-q', '-b', 'codex/other-branch']);
  const wrongBranch = await diagnosticFrom(
    captureBaseline(contract), 'GIT_BRANCH_MISMATCH',
  );
  assert.ok(wrongBranch, 'capture must still raise GIT_BRANCH_MISMATCH');
  assert.equal(wrongBranch.observed, 'codex/other-branch');

  const noUpstream = await diagnosticFrom(captureBaseline(contractFor(repo, {
    preflight: [{ id: 'G1', type: 'git', target: repo, require_upstream: true }],
  }), { phase: 'capture' }), 'GIT_UPSTREAM_REQUIRED');
  assert.ok(noUpstream, 'capture must still raise GIT_UPSTREAM_REQUIRED');
});

// 谓词在 verify 停跑之后，git 边界完全落在 baseline compare 上。这条把三个谓词各自对应的越界
// 动作都做一遍，证明「跳过判定」没有连同边界一起跳过——否则 F-2 的修法就是拿 fail-open 换 fail-closed。
test('verify keeps the git boundary through compare once the phase predicates stop running', async (t) => {
  const repo = await createRepository(t);
  await rm(join(repo, 'dirty-before.txt'));
  await git(repo, ['update-ref', 'refs/remotes/origin/codex/test-snapshot', 'HEAD']);
  await git(repo, ['config', 'remote.origin.url', '.']);
  await git(repo, ['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']);
  await git(repo, ['config', 'branch.codex/test-snapshot.remote', 'origin']);
  await git(repo, ['config', 'branch.codex/test-snapshot.merge', 'refs/heads/codex/test-snapshot']);
  const contract = contractFor(repo, {
    preflight: [{
      id: 'G1',
      type: 'git',
      target: repo,
      require_branch: 'codex/test-snapshot',
      require_clean: true,
      require_upstream: true,
    }],
  });
  const baseline = await captureBaseline(contract);
  assert.equal(baseline.entries.find((entry) => entry.id === 'G1').upstream, 'origin/codex/test-snapshot');

  // 未声明的文件改动：谓词不再拦，逐路径比对必须拦。
  await writeFile(join(repo, 'protected.txt'), 'undeclared mutation\n');
  const mutated = compareTrusted(contract, baseline, await captureAgainst(contract, baseline));
  assert.equal(mutated.ok, false);
  assert.equal(hasViolation(mutated, 'FILE_MUTATION_NOT_ALLOWED', 'G1'), true);
  await writeFile(join(repo, 'protected.txt'), 'protected\n');

  // 切走分支：GIT_BRANCH_MISMATCH 不再触发，GIT_BRANCH_CHANGED 必须接住。
  await git(repo, ['checkout', '-q', '-b', 'codex/other-branch']);
  const switched = compareTrusted(contract, baseline, await captureAgainst(contract, baseline));
  assert.equal(switched.ok, false);
  assert.equal(hasViolation(switched, 'GIT_BRANCH_CHANGED', 'G1'), true);
  assert.equal(hasViolation(switched, 'GIT_BRANCH_MISMATCH', 'G1'), false);
  await git(repo, ['checkout', '-q', 'codex/test-snapshot']);

  // 抹掉 upstream：GIT_UPSTREAM_REQUIRED 不再触发，GIT_UPSTREAM_CHANGED 必须接住。
  await git(repo, ['config', '--unset', 'branch.codex/test-snapshot.remote']);
  const unlinked = compareTrusted(contract, baseline, await captureAgainst(contract, baseline));
  assert.equal(unlinked.ok, false);
  assert.equal(hasViolation(unlinked, 'GIT_UPSTREAM_CHANGED', 'G1'), true);
  assert.equal(hasViolation(unlinked, 'GIT_UPSTREAM_REQUIRED', 'G1'), false);
});

// phase 必须是必填而不是「缺省 capture」：缺省会让将来漏传的 verify 类调用点静默退回 F-2 的
// 结构性必红——那正是这个参数被引入要消灭的形态，而闭集校验对「压根没传」是看不见的。
test('captureSnapshot fails closed on a missing phase and on one outside the declared pair', async (t) => {
  const repo = await createRepository(t);
  const rejectsWith = (observed) => (error) => error.diagnostics?.some(
    (diagnostic) => diagnostic.code === 'SNAPSHOT_PHASE_INVALID'
      && diagnostic.observed === observed
      && diagnostic.expected === 'capture or verify'
      && diagnostic.next,
  );
  await assert.rejects(captureSnapshot(contractFor(repo)), rejectsWith('undefined'));
  await assert.rejects(captureSnapshot(contractFor(repo), {}), rejectsWith('undefined'));
  await assert.rejects(
    captureSnapshot(contractFor(repo), { baselineGitHeads: undefined }), rejectsWith('undefined'),
  );
  await assert.rejects(
    captureSnapshot(contractFor(repo), { phase: 'postflight' }), rejectsWith('postflight'),
  );
});

test('fails closed with complete diagnostics for non-Git roots, multiple roots, and failing argv commands', async (t) => {
  const repo = await createRepository(t);
  const nonGitRoot = join(repo, 'not-a-worktree');
  await mkdir(nonGitRoot);

  await assert.rejects(
    captureBaseline(contractFor(repo, {
      preflight: [{ id: 'NG1', type: 'git', target: nonGitRoot }],
    })),
    (error) => error.diagnostics?.some((diagnostic) => diagnostic.entry === 'NG1'
      && diagnostic.field === 'target'
      && diagnostic.observed === nonGitRoot
      && diagnostic.expected === 'Git worktree'
      && diagnostic.next),
  );

  await assert.rejects(
    captureBaseline(contractFor(repo, { target_roots: [repo, nonGitRoot] })),
    (error) => error.diagnostics?.some((diagnostic) => diagnostic.field === 'target_roots'
      && diagnostic.observed.includes(nonGitRoot)
      && diagnostic.expected === 'exactly one target root'
      && diagnostic.next),
  );

  await assert.rejects(
    captureBaseline(contractFor(repo, {
      preflight: [{ id: 'CMD1', type: 'command', cwd: repo, argv: ['node', '-e', 'process.exit(7)'] }],
    })),
    (error) => error.diagnostics?.some((diagnostic) => diagnostic.entry === 'CMD1'
      && diagnostic.field === 'argv'
      && diagnostic.observed.includes('exit code 7')
      && diagnostic.expected === 'exit code 0'
      && diagnostic.next),
  );
});

test('rejects unsupported file glob patterns before snapshot capture', async (t) => {
  const repo = await createRepository(t);
  const contract = contractFor(repo, {
    allowed_mutations: { files: [join(repo, '*.txt')], git: ['commit'], external: [] },
  });

  await assert.rejects(
    captureBaseline(contract),
    (error) => error.diagnostics?.some((diagnostic) => diagnostic.field === 'allowed_mutations.files[0]'
      && diagnostic.observed === join(repo, '*.txt')
      && diagnostic.expected === 'absolute exact path or directory prefix ending /**'
      && diagnostic.next),
  );
});

test('capture CLI never leaves a launchable baseline when preflight fails', async (t) => {
  const repo = await createRepository(t);
  const contractPath = join(repo, 'contract.json');
  const baselinePath = join(repo, 'baseline.json');
  await writeFile(contractPath, canonicalJson(contractFor(repo, {
    preflight: [{ id: 'BR1', type: 'git', target: repo, require_branch: 'codex/wrong-branch' }],
  })));

  await assert.rejects(
    execFile(process.execPath, [
      'goal-condition-template/scripts/snapshot.mjs', 'capture',
      '--contract', contractPath, '--out', baselinePath,
    ], { cwd: workspaceRoot }),
    (error) => error.code === 1,
  );
  await assert.rejects(readFile(baselinePath, 'utf8'), { code: 'ENOENT' });
});

test('snapshot CLI does not echo a user-controlled contract path on read failure', async () => {
  const canary = 'PRIVATE_PATH_CANARY_4f2d';
  await assert.rejects(
    execFile(process.execPath, [
      'goal-condition-template/scripts/snapshot.mjs', 'capture',
      '--contract', join(workspaceRoot, `${canary}.json`),
      '--out', join(workspaceRoot, '.unreachable-baseline.json'),
    ], { cwd: workspaceRoot }),
    (error) => error.code === 1
      && error.stderr.includes('CONTRACT_READ_FAILED')
      && !error.stderr.includes(canary),
  );
});

test('verify CLI rejects a mismatched baseline hash before running current preflight commands', async (t) => {
  const repo = await createRepository(t);
  const contract = contractFor(repo, {
    preflight: [{ id: 'STOP1', type: 'command', cwd: repo, argv: ['node', '-e', 'process.exit(9)'] }],
  });
  const contractPath = join(repo, 'contract.json');
  const baselinePath = join(repo, 'baseline.json');
  await writeFile(contractPath, canonicalJson(contract));
  const baseline = {
    schema_version: 3,
    contract_hash: '0'.repeat(64),
    captured_at: '2026-01-01T00:00:00.000Z',
    contexts: [],
    entries: [],
  };
  await writeFile(baselinePath, `${JSON.stringify(baseline)}\n`);

  await assert.rejects(
    execFile(process.execPath, [
      'goal-condition-template/scripts/snapshot.mjs', 'verify',
      '--contract', contractPath, '--baseline', baselinePath,
      '--expected-baseline-digest', snapshotDigest(baseline),
    ], { cwd: workspaceRoot }),
    (error) => error.code === 1
      && error.stderr.includes('CONTRACT_HASH_MISMATCH')
      && !error.stderr.includes('COMMAND_FAILED'),
  );
});

test('verify CLI rejects a baseline missing declared preflight entries before current capture', async (t) => {
  const repo = await createRepository(t);
  const contract = contractFor(repo, {
    preflight: [{ id: 'SAFE1', type: 'command', cwd: repo, argv: ['node', '--version'] }],
  });
  const contractPath = join(repo, 'contract.json');
  const baselinePath = join(repo, 'baseline.json');
  await writeFile(contractPath, canonicalJson(contract));
  const baseline = await captureBaseline(contract);
  baseline.entries = [];
  await writeFile(baselinePath, `${JSON.stringify(baseline)}\n`);

  await assert.rejects(
    execFile(process.execPath, [
      'goal-condition-template/scripts/snapshot.mjs', 'verify',
      '--contract', contractPath, '--baseline', baselinePath,
      '--expected-baseline-digest', snapshotDigest(baseline),
    ], { cwd: workspaceRoot }),
    (error) => error.code === 1 && error.stderr.includes('SNAPSHOT_ENTRY_SET_MISMATCH'),
  );
});

test('verify CLI requires a trusted external baseline digest with an auditable diagnostic', async (t) => {
  const repo = await createRepository(t);
  const contract = contractFor(repo);
  const contractPath = join(repo, 'contract.json');
  const baselinePath = join(repo, 'baseline.json');
  await writeFile(contractPath, canonicalJson(contract));
  await writeFile(baselinePath, `${JSON.stringify(await captureBaseline(contract))}\n`);

  await assert.rejects(
    execFile(process.execPath, [
      'goal-condition-template/scripts/snapshot.mjs', 'verify',
      '--contract', contractPath, '--baseline', baselinePath,
    ], { cwd: workspaceRoot }),
    (error) => error.code === 1
      && error.stderr.includes('EXPECTED_BASELINE_DIGEST_REQUIRED')
      && error.stderr.includes('entry=baseline')
      && error.stderr.includes('field=--expected-baseline-digest'),
  );
});

// 上面那条阶段用例直接调 captureSnapshot，钉不住生产调用点有没有把 phase 传下去；这条走真 CLI，
// 复现的正是冒烟 pass 1 的红：run 完全成功，verify 却因为重跑 require_clean 而红。
test('verify CLI exits 0 for a declared run product under require_clean', async (t) => {
  const repo = await createRepository(t);
  await rm(join(repo, 'dirty-before.txt'));
  const contract = contractFor(repo, {
    preflight: [{
      id: 'G1', type: 'git', target: repo, require_branch: 'codex/test-snapshot', require_clean: true,
    }],
  });
  // baseline 必须在写任何辅助文件之前拿到，否则 require_clean 在 capture 阶段就红了。
  const baseline = await captureBaseline(contract);
  // contract 与 baseline 必须落在 target root 之外：它们不在 allowed_mutations.files 里，
  // 写进仓内就会以未声明变更的身份把这条本该绿的用例染红。
  const controllerDir = await mkdtemp(join(workspaceRoot, '.snapshot-cli-'));
  t.after(() => rm(controllerDir, { recursive: true, force: true }));
  const contractPath = join(controllerDir, 'contract.json');
  const baselinePath = join(controllerDir, 'baseline.json');
  await writeFile(contractPath, canonicalJson(contract));
  await writeFile(baselinePath, `${JSON.stringify(baseline)}\n`);
  await writeFile(join(repo, 'tracked.txt'), 'run product\n');

  const { stdout } = await execFile(process.execPath, [
    'goal-condition-template/scripts/snapshot.mjs', 'verify',
    '--contract', contractPath, '--baseline', baselinePath,
    '--expected-baseline-digest', snapshotDigest(baseline),
  ], { cwd: workspaceRoot });
  const result = JSON.parse(stdout);
  assert.deepEqual(result.violations, []);
  assert.equal(result.ok, true);
  assert.deepEqual(result.changes.map((change) => change.path), [join(repo, 'tracked.txt')]);
});

test('requires a trusted external baseline digest and rejects replaced or malformed entry payloads', async (t) => {
  const repo = await createRepository(t);
  const contract = contractFor(repo);
  const baseline = await captureBaseline(contract);
  await writeFile(join(repo, 'protected.txt'), 'protected mutation\n');
  const current = await captureBaseline(contract);
  const trustedDigest = snapshotDigest(baseline);

  const replaced = structuredClone(baseline);
  replaced.entries = structuredClone(current.entries);
  assert.equal(compareSnapshot(contract, replaced, current, { expectedBaselineDigest: trustedDigest }).ok, false);
  assert.equal(hasViolation(
    compareSnapshot(contract, replaced, current, { expectedBaselineDigest: trustedDigest }),
    'BASELINE_DIGEST_MISMATCH',
  ), true);

  const malformed = structuredClone(baseline);
  delete malformed.entries[0].effective;
  const malformedResult = compareSnapshot(contract, malformed, current, {
    expectedBaselineDigest: snapshotDigest(malformed),
  });
  assert.equal(malformedResult.ok, false);
  assert.equal(hasViolation(malformedResult, 'SNAPSHOT_ENTRY_INVALID', 'G1'), true);
  const malformedTarget = structuredClone(baseline);
  delete malformedTarget.entries[0].target;
  assert.doesNotThrow(() => compareSnapshot(contract, malformedTarget, current, {
    expectedBaselineDigest: snapshotDigest(malformedTarget),
  }));
  assert.equal(hasViolation(compareSnapshot(contract, malformedTarget, current, {
    expectedBaselineDigest: snapshotDigest(malformedTarget),
  }), 'SNAPSHOT_ENTRY_CONTRACT_MISMATCH', 'G1'), true);
  assert.equal(hasViolation(compareSnapshot(contract, baseline, current), 'EXPECTED_BASELINE_DIGEST_REQUIRED'), true);
});

test('rejects preflight targets, command cwd, and allowed paths outside the declared root', async (t) => {
  const repo = await createRepository(t);
  const outside = await createRepository(t);
  const outsideFile = join(outside, 'outside.txt');

  for (const [name, overrides, entry] of [
    ['git target', { preflight: [{ id: 'XG1', type: 'git', target: outside }] }, 'XG1'],
    ['path target', { preflight: [{ id: 'XP1', type: 'path', target: outsideFile, require: 'file' }] }, 'XP1'],
    ['command cwd', { preflight: [{ id: 'XC1', type: 'command', cwd: outside, argv: ['node', '--version'] }] }, 'XC1'],
    ['allowed path', { allowed_mutations: { files: [outsideFile], git: ['commit'], external: [] } }, 'contract'],
  ]) {
    await assert.rejects(
      captureBaseline(contractFor(repo, overrides)),
      (error) => error.diagnostics?.some((diagnostic) => diagnostic.code === 'TARGET_ROOT_ESCAPE'
        && diagnostic.entry === entry && diagnostic.next),
      name,
    );
  }
});

test('rejects direct and nested symlinks that escape the declared root', async (t) => {
  const repo = await createRepository(t);
  const outside = await mkdtemp(join(workspaceRoot, '.snapshot-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));

  const direct = join(repo, 'direct-escape');
  await symlink(outside, direct);
  await assert.rejects(
    captureBaseline(contractFor(repo, {
      allowed_mutations: { files: [direct], git: ['commit'], external: [] },
    })),
    (error) => error.diagnostics?.some((diagnostic) => diagnostic.code === 'SYMLINK_ESCAPES_TARGET_ROOT'
      && diagnostic.field === 'allowed_mutations.files[0]'),
  );
  await rm(direct);

  const nested = join(repo, 'nested');
  await mkdir(nested);
  await symlink(outside, join(nested, 'escape'));
  await assert.rejects(
    captureBaseline(contractFor(repo, {
      allowed_mutations: { files: [join(nested, '/**')], git: ['commit'], external: [] },
    })),
    (error) => error.diagnostics?.some((diagnostic) => diagnostic.code === 'SYMLINK_ESCAPES_TARGET_ROOT'
      && diagnostic.entry === 'contract'
      && diagnostic.field === 'allowed_mutations.files[0]'),
  );
  await rm(nested, { recursive: true, force: true });

  const ignored = join(repo, 'ignored');
  await writeFile(join(repo, '.gitignore'), 'ignored/\n');
  await mkdir(ignored);
  await symlink(outside, join(ignored, 'escape'));
  await assert.rejects(
    captureBaseline(contractFor(repo, {
      allowed_mutations: { files: [join(ignored, '/**')], git: ['commit'], external: [] },
    })),
    (error) => error.diagnostics?.some((diagnostic) => diagnostic.code === 'SYMLINK_ESCAPES_TARGET_ROOT'
      && diagnostic.entry === 'contract'
      && diagnostic.field === 'allowed_mutations.files[0]'),
  );
});

test('compares effective file content instead of misclassifying existing dirty state after commit', async (t) => {
  const repo = await createRepository(t);
  const contract = contractFor(repo);
  const protectedPath = join(repo, 'protected.txt');
  await writeFile(protectedPath, 'baseline protected dirty\n');
  const baseline = await captureBaseline(contract);

  await git(repo, ['add', 'protected.txt']);
  await git(repo, ['commit', '-m', 'preserve baseline dirty content']);
  const committed = await captureAgainst(contract, baseline);
  assert.equal(compareTrusted(contract, baseline, committed).ok, true, 'committed unchanged dirty content');

  await writeFile(protectedPath, 'protected\n');
  const reverted = await captureBaseline(contract);
  assert.equal(hasViolation(compareTrusted(contract, committed, reverted), 'FILE_MUTATION_NOT_ALLOWED', 'G1'), true,
    'reverted protected content');

  await writeFile(protectedPath, 'further protected mutation\n');
  const furtherModified = await captureBaseline(contract);
  assert.equal(hasViolation(compareTrusted(contract, committed, furtherModified), 'FILE_MUTATION_NOT_ALLOWED', 'G1'), true,
    'further protected content');
});

test('preserves staged baseline content and classifies only later effective deltas', async (t) => {
  const repo = await createRepository(t);
  const contract = contractFor(repo);
  const trackedPath = join(repo, 'tracked.txt');
  await writeFile(trackedPath, 'baseline staged allowed\n');
  await git(repo, ['add', 'tracked.txt']);
  const baseline = await captureBaseline(contract);

  const unchanged = await captureBaseline(contract);
  assert.equal(compareTrusted(contract, baseline, unchanged).ok, true);
  await writeFile(trackedPath, 'further allowed mutation\n');
  const furtherModified = await captureBaseline(contract);
  const result = compareTrusted(contract, baseline, furtherModified);
  assert.equal(result.ok, true);
  assert.deepEqual(result.changes.map((change) => change.path), [trackedPath]);
});

test('detects protected chmod-only mutations in the complete worktree inventory', async (t) => {
  const repo = await createRepository(t);
  const contract = contractFor(repo);
  const baseline = await captureBaseline(contract);

  await chmod(join(repo, 'protected.txt'), 0o600);
  const result = compareTrusted(contract, baseline, await captureBaseline(contract));

  assert.equal(result.ok, false);
  assert.equal(hasViolation(result, 'FILE_MUTATION_NOT_ALLOWED', 'G1'), true);
});

test('detects target-root directory mode changes in the complete worktree inventory', async (t) => {
  const repo = await createRepository(t);
  const contract = contractFor(repo);
  const baseline = await captureBaseline(contract);

  await chmod(repo, 0o750);
  const current = await captureBaseline(contract);
  const result = compareTrusted(contract, baseline, current);

  assert.equal(result.ok, false);
  assert.equal(hasViolation(result, 'FILE_MUTATION_NOT_ALLOWED', 'G1'), true);
});

test('captures index mode object and stage independently from worktree bytes', async (t) => {
  const repo = await createRepository(t);
  const contract = contractFor(repo);
  const baseline = await captureBaseline(contract);
  const protectedPath = join(repo, 'protected.txt');

  await writeFile(protectedPath, 'staged-only protected mutation\n');
  await git(repo, ['add', 'protected.txt']);
  await writeFile(protectedPath, 'protected\n');
  const current = await captureBaseline(contract);
  const indexEntry = current.entries.find((entry) => entry.id === 'G1').index
    .find((entry) => entry.path === 'protected.txt');
  const result = compareTrusted(contract, baseline, current);

  assert.deepEqual(Object.keys(indexEntry).sort(), ['mode', 'object', 'path', 'stage']);
  assert.equal(result.ok, false);
  assert.equal(hasViolation(result, 'GIT_INDEX_MUTATION_NOT_ALLOWED', 'G1'), true);
});

test('allows only the current branch ref move consistent with an allowed commit', async (t) => {
  const repo = await createRepository(t);
  const contract = contractFor(repo);
  const baseline = await captureBaseline(contract);

  await writeFile(join(repo, 'tracked.txt'), 'allowed committed change\n');
  await git(repo, ['add', 'tracked.txt']);
  await git(repo, ['commit', '-m', 'allowed commit']);
  const committed = await captureAgainst(contract, baseline);
  assert.equal(compareTrusted(contract, baseline, committed).ok, true);

  await git(repo, ['tag', 'undeclared-tag']);
  const tagged = await captureAgainst(contract, baseline);
  const result = compareTrusted(contract, baseline, tagged);
  assert.equal(result.ok, false);
  assert.equal(hasViolation(result, 'GIT_REFS_CHANGED', 'G1'), true);
});

test('rejects backward and unrelated branch ref moves even when commit mutation is allowed', async (t) => {
  await t.test('backward ref move', async (subtest) => {
    const repo = await createRepository(subtest);
    const contract = contractFor(repo);
    await writeFile(join(repo, 'tracked.txt'), 'second revision\n');
    await git(repo, ['add', 'tracked.txt']);
    await git(repo, ['commit', '-m', 'second revision']);
    const baseline = await captureBaseline(contract);
    const parent = (await git(repo, ['rev-parse', 'HEAD^'])).stdout.trim();

    await git(repo, ['update-ref', 'refs/heads/codex/test-snapshot', parent]);
    const current = await captureAgainst(contract, baseline);
    const result = compareTrusted(contract, baseline, current);

    assert.equal(current.entries.find((entry) => entry.id === 'G1').ancestry.is_ancestor, false);
    assert.equal(result.ok, false);
    assert.equal(hasViolation(result, 'GIT_COMMIT_NOT_FORWARD', 'G1'), true);
  });

  await t.test('unrelated ref move', async (subtest) => {
    const repo = await createRepository(subtest);
    const contract = contractFor(repo);
    const baseline = await captureBaseline(contract);
    const tree = (await git(repo, ['write-tree'])).stdout.trim();
    const unrelated = (await git(repo, ['commit-tree', tree, '-m', 'unrelated root'])).stdout.trim();

    await git(repo, ['update-ref', 'refs/heads/codex/test-snapshot', unrelated]);
    const current = await captureAgainst(contract, baseline);
    const result = compareTrusted(contract, baseline, current);

    assert.equal(current.entries.find((entry) => entry.id === 'G1').ancestry.is_ancestor, false);
    assert.equal(result.ok, false);
    assert.equal(hasViolation(result, 'GIT_COMMIT_NOT_FORWARD', 'G1'), true);
  });
});

test('rejects a forward commit-tree child with protected committed bytes hidden from index and worktree', async (t) => {
  const repo = await createRepository(t);
  const contract = contractFor(repo);
  const baseline = await captureBaseline(contract);
  const baselineEntry = baseline.entries.find((entry) => entry.id === 'G1');

  await writeFile(join(repo, 'protected.txt'), 'malicious committed material\n');
  await git(repo, ['add', 'protected.txt']);
  const maliciousTree = (await git(repo, ['write-tree'])).stdout.trim();
  await git(repo, ['reset', '--hard', baselineEntry.head]);
  const child = (await git(repo, ['commit-tree', maliciousTree, '-p', baselineEntry.head, '-m', 'hidden protected child'])).stdout.trim();
  await git(repo, ['update-ref', 'refs/heads/codex/test-snapshot', child]);

  const current = await captureAgainst(contract, baseline);
  const currentEntry = current.entries.find((entry) => entry.id === 'G1');
  const result = compareTrusted(contract, baseline, current);

  assert.deepEqual(currentEntry.index, baselineEntry.index, 'index stayed at baseline');
  assert.deepEqual(currentEntry.inventory, baselineEntry.inventory, 'worktree stayed at baseline');
  assert.equal(currentEntry.ancestry.is_ancestor, true);
  assert.equal(result.ok, false);
  assert.equal(hasViolation(result, 'GIT_COMMITTED_MATERIAL_NOT_ALLOWED', 'G1'), true);
});

test('classifies committed chmod, type, deletion, and addition by protected versus allowed path', async (t) => {
  const cases = [
    ['chmod', 'protected.txt', false],
    ['chmod', 'tracked.txt', true],
    ['type', 'protected.txt', false],
    ['type', 'tracked.txt', true],
    ['delete', 'protected.txt', false],
    ['delete', 'tracked.txt', true],
    ['add', 'protected-added.txt', false],
    ['add', 'allowed-added.txt', true],
  ];

  for (const [mutation, pathname, allowed] of cases) {
    await t.test(`${mutation} ${allowed ? 'allowed' : 'protected'}`, async (subtest) => {
      const repo = await createRepository(subtest);
      const allowedFiles = [join(repo, 'tracked.txt')];
      if (pathname === 'allowed-added.txt') allowedFiles.push(join(repo, pathname));
      const contract = contractFor(repo, {
        allowed_mutations: { files: allowedFiles, git: ['commit'], external: [] },
      });
      const baseline = await captureBaseline(contract);
      const baselineEntry = baseline.entries.find((entry) => entry.id === 'G1');
      const tracked = baselineEntry.tree.find((entry) => entry.path === pathname);
      let treeMode = tracked?.mode;
      let object = tracked?.object;
      let remove = false;
      if (mutation === 'chmod') {
        treeMode = '100755';
      } else if (mutation === 'type') {
        treeMode = '120000';
        object = await writeGitBlob(repo, 'context.md', 'symlink-blob');
      } else if (mutation === 'delete') {
        remove = true;
      } else {
        treeMode = '100644';
        object = await writeGitBlob(repo, `${pathname} content\n`, 'added-blob');
      }
      await createTreeOnlyCommit(repo, baselineEntry, {
        pathname, mode: treeMode, object, remove, message: `${mutation} ${pathname}`,
      });

      const current = await captureAgainst(contract, baseline);
      const currentEntry = current.entries.find((entry) => entry.id === 'G1');
      assert.deepEqual(currentEntry.index, baselineEntry.index, 'real index stayed at baseline');
      assert.deepEqual(currentEntry.inventory, baselineEntry.inventory, 'real worktree stayed at baseline');
      const result = compareTrusted(contract, baseline, current);
      if (allowed) {
        assert.equal(result.ok, true);
        assert.equal(result.changes.some((change) => change.kind === 'git_committed_material'
          && change.path === join(repo, pathname)), true);
      } else {
        assert.equal(result.ok, false);
        assert.equal(hasViolation(result, 'GIT_COMMITTED_MATERIAL_NOT_ALLOWED', 'G1'), true);
      }
    });
  }
});

test('rejects raw committed bytes that only match smudged protected worktree material', async (t) => {
  const repo = await createRepository(t);
  await writeFile(join(repo, '.gitattributes'), 'protected.txt text eol=lf\n');
  await git(repo, ['add', '.gitattributes']);
  await git(repo, ['commit', '-m', 'declare protected clean projection']);
  const contract = contractFor(repo);
  const smudgedBytes = Buffer.from('protected\r\n');
  await writeFile(join(repo, 'protected.txt'), smudgedBytes);
  const baseline = await captureBaseline(contract);
  const baselineEntry = baseline.entries.find((entry) => entry.id === 'G1');
  const rawObject = await writeGitBlob(repo, smudgedBytes, 'raw-smudged-blob');

  await createTreeOnlyCommit(repo, baselineEntry, {
    pathname: 'protected.txt', mode: '100644', object: rawObject,
    message: 'commit raw smudged bytes',
  });
  const current = await captureAgainst(contract, baseline);
  const currentEntry = current.entries.find((entry) => entry.id === 'G1');
  const baselineRawHash = baselineEntry.effective.find((entry) => entry.path === 'protected.txt').bytes_sha256;
  const currentTreeHash = currentEntry.tree.find((entry) => entry.path === 'protected.txt').bytes_sha256;
  const result = compareTrusted(contract, baseline, current);

  assert.equal(currentTreeHash, baselineRawHash, 'raw hashes alone would treat the malicious blob as unchanged');
  assert.notEqual(
    baselineEntry.effective_tree.find((entry) => entry.path === 'protected.txt').object,
    currentEntry.tree.find((entry) => entry.path === 'protected.txt').object,
    'Git clean-filter projection distinguishes the committed object',
  );
  assert.equal(hasViolation(result, 'GIT_COMMITTED_MATERIAL_NOT_ALLOWED', 'G1'), true);
});

test('rejects fake ancestry metadata before it can bless an unrelated commit', async (t) => {
  const repo = await createRepository(t);
  const contract = contractFor(repo);
  const baseline = await captureBaseline(contract);
  const baselineEntry = baseline.entries.find((entry) => entry.id === 'G1');
  const tree = (await git(repo, ['write-tree'])).stdout.trim();
  const unrelated = (await git(repo, ['commit-tree', tree, '-m', 'unrelated graft target'])).stdout.trim();
  await writeFile(join(repo, '.git', 'info', 'grafts'), `${unrelated} ${baselineEntry.head}\n`);
  await git(repo, ['update-ref', 'refs/heads/codex/test-snapshot', unrelated]);

  await assert.rejects(
    captureAgainst(contract, baseline),
    (error) => error.diagnostics?.some((item) => item.code === 'GIT_GRAFTS_UNSUPPORTED'
      && item.entry === 'G1'),
  );
});

test('rejects a pre-existing replacement ref that changes the current commit tree view', async (t) => {
  const repo = await createRepository(t);
  const contract = contractFor(repo);
  const head = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
  const originalTree = await git(repo, ['--no-replace-objects', 'ls-tree', '-r', '-z', head]);
  const originalProtectedObject = treeObject(originalTree.stdout, 'protected.txt');

  await writeFile(join(repo, 'protected.txt'), 'replacement protected bytes\n');
  await git(repo, ['add', 'protected.txt']);
  const replacementTree = (await git(repo, ['write-tree'])).stdout.trim();
  const replacementProtectedObject = treeObject(
    (await git(repo, ['ls-tree', '-r', '-z', replacementTree])).stdout,
    'protected.txt',
  );
  await git(repo, ['reset', '--hard', head]);
  const replacementCommit = (await git(repo, [
    'commit-tree', replacementTree, '-m', 'replacement commit view',
  ])).stdout.trim();
  await git(repo, ['replace', head, replacementCommit]);

  const replacedView = await git(repo, ['ls-tree', '-r', '-z', head]);
  const rawView = await git(repo, ['--no-replace-objects', 'ls-tree', '-r', '-z', head]);
  assert.equal(treeObject(replacedView.stdout, 'protected.txt'), replacementProtectedObject);
  assert.equal(treeObject(rawView.stdout, 'protected.txt'), originalProtectedObject);
  assert.notEqual(originalProtectedObject, replacementProtectedObject);

  await assert.rejects(
    captureBaseline(contract),
    (error) => error.diagnostics?.some((item) => item.code === 'GIT_REPLACE_REFS_UNSUPPORTED'
      && item.entry === 'G1'),
  );
});

test('rejects changed loose blob bytes under the same object id with unchanged HEAD', async (t) => {
  const repo = await createRepository(t);
  const contract = contractFor(repo);
  const baseline = await captureBaseline(contract);
  const baselineEntry = baseline.entries.find((entry) => entry.id === 'G1');
  const protectedEntry = baselineEntry.tree.find((entry) => entry.path === 'protected.txt');
  const forgedCurrent = structuredClone(baseline);
  forgedCurrent.entries.find((entry) => entry.id === 'G1').tree
    .find((entry) => entry.path === 'protected.txt').bytes_sha256 = 'f'.repeat(64);
  const forgedResult = compareTrusted(contract, baseline, forgedCurrent);
  assert.equal(forgedResult.ok, false);
  assert.equal(hasViolation(forgedResult, 'GIT_COMMITTED_OBJECT_INTEGRITY_CHANGED', 'G1'), true);

  const objectPath = join(repo, '.git', 'objects', protectedEntry.object.slice(0, 2), protectedEntry.object.slice(2));
  const originalLooseObject = await inflate(await readFile(objectPath));
  assert.deepEqual(originalLooseObject, Buffer.from('blob 10\0protected\n'));

  await chmod(objectPath, 0o644);
  await writeFile(objectPath, await deflate(Buffer.from('blob 10\0tampered!\n')));
  assert.equal((await git(repo, ['rev-parse', 'HEAD'])).stdout.trim(), baselineEntry.head);

  await assert.rejects(
    captureAgainst(contract, baseline),
    (error) => error.diagnostics?.some((item) => item.code === 'GIT_BLOB_OBJECT_MISMATCH'
      && item.entry === 'G1' && item.field === 'tree.object'),
  );
});

test('rejects a forward detached HEAD because no current branch ref moved', async (t) => {
  const repo = await createRepository(t);
  await git(repo, ['checkout', '--detach']);
  const contract = contractFor(repo, {
    preflight: [{ id: 'G1', type: 'git', target: repo, require_clean: false }],
  });
  const baseline = await captureBaseline(contract);
  await writeFile(join(repo, 'tracked.txt'), 'detached allowed change\n');
  await git(repo, ['add', 'tracked.txt']);
  await git(repo, ['commit', '-m', 'detached child']);

  const current = await captureAgainst(contract, baseline);
  const result = compareTrusted(contract, baseline, current);
  assert.equal(current.entries.find((entry) => entry.id === 'G1').ancestry.is_ancestor, true);
  assert.equal(result.ok, false);
  assert.equal(hasViolation(result, 'GIT_COMMIT_REF_INCONSISTENT', 'G1'), true);
});

test('allows a pre-existing protected file-to-directory dirty state to be committed unchanged', async (t) => {
  const repo = await createRepository(t);
  const contract = contractFor(repo);
  await rm(join(repo, 'protected.txt'));
  await mkdir(join(repo, 'protected.txt'));
  await writeFile(join(repo, 'protected.txt', 'child.txt'), 'pre-existing protected child\n');
  const baseline = await captureBaseline(contract);
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-m', 'preserve protected directory material']);

  const current = await captureAgainst(contract, baseline);
  const result = compareTrusted(contract, baseline, current);
  assert.equal(result.ok, true);
  assert.equal(result.changes.some((change) => change.kind === 'git_committed_existing_material'), true);
});

test('schema and external digest bind ancestry and exact committed-tree material evidence', async (t) => {
  const repo = await createRepository(t);
  const contract = contractFor(repo);
  const baseline = await captureBaseline(contract);
  const entry = baseline.entries.find((item) => item.id === 'G1');
  const blob = entry.tree.find((item) => item.type === 'blob');

  assert.equal(baseline.schema_version, 3);
  assert.deepEqual(Object.keys(entry.ancestry).sort(), ['baseline_head', 'current_head', 'is_ancestor']);
  assert.deepEqual(Object.keys(entry.history).sort(), ['grafts', 'replace_objects_ignored', 'shallow']);
  assert.deepEqual(Object.keys(blob).sort(), ['bytes_sha256', 'mode', 'object', 'path', 'type']);
  assert.equal(entry.effective_tree.some((item) => item.type === 'file' && /^[0-9a-f]{40,64}$/.test(item.object)), true);

  const replacedEvidence = structuredClone(baseline);
  replacedEvidence.entries.find((item) => item.id === 'G1').tree
    .find((item) => item.path === blob.path).bytes_sha256 = 'f'.repeat(64);
  const replacedResult = compareSnapshot(contract, replacedEvidence, baseline, {
    expectedBaselineDigest: snapshotDigest(baseline),
  });
  assert.equal(hasViolation(replacedResult, 'BASELINE_DIGEST_MISMATCH'), true);

  const malformedEvidence = structuredClone(baseline);
  delete malformedEvidence.entries.find((item) => item.id === 'G1').ancestry.current_head;
  const malformedResult = compareSnapshot(contract, malformedEvidence, baseline, {
    expectedBaselineDigest: snapshotDigest(malformedEvidence),
  });
  assert.equal(hasViolation(malformedResult, 'SNAPSHOT_ENTRY_INVALID', 'G1'), true);
});

test('fails closed when a pre-existing ignored file changes outside allowed mutations', async (t) => {
  const repo = await createRepository(t);
  const contract = contractFor(repo);
  const ignoredDirectory = join(repo, 'ignored');
  const ignoredProtected = join(ignoredDirectory, 'protected.txt');
  await writeFile(join(repo, '.gitignore'), 'ignored/\n');
  await mkdir(ignoredDirectory);
  await writeFile(ignoredProtected, 'baseline ignored protected content\n');
  await git(repo, ['add', '.gitignore']);
  await git(repo, ['commit', '-m', 'ignore local working data']);
  const baseline = await captureBaseline(contract);

  await writeFile(ignoredProtected, 'mutated ignored protected content\n');
  const current = await captureBaseline(contract);
  const result = compareTrusted(contract, baseline, current);

  assert.equal(result.ok, false);
  assert.equal(hasViolation(result, 'FILE_MUTATION_NOT_ALLOWED', 'G1'), true);
  assert.equal(result.violations.find((item) => item.code === 'FILE_MUTATION_NOT_ALLOWED').observed, ignoredProtected);
});

test('fails closed when an ignored symlink changes from in-root to an escaping referent', async (t) => {
  const repo = await createRepository(t);
  const contract = contractFor(repo);
  const outside = await mkdtemp(join(workspaceRoot, '.snapshot-ignored-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const ignoredDirectory = join(repo, 'ignored');
  const ignoredLink = join(ignoredDirectory, 'link');
  await writeFile(join(repo, '.gitignore'), 'ignored/\n');
  await mkdir(ignoredDirectory);
  await symlink('../tracked.txt', ignoredLink);
  await git(repo, ['add', '.gitignore']);
  await git(repo, ['commit', '-m', 'ignore local symlink']);
  await captureBaseline(contract);

  await rm(ignoredLink);
  await symlink(outside, ignoredLink);
  await assert.rejects(
    captureBaseline(contract),
    (error) => error.diagnostics?.some((diagnostic) => diagnostic.code === 'SYMLINK_ESCAPES_TARGET_ROOT'
      && diagnostic.entry === 'G1'
      && diagnostic.field === 'target'),
  );
});

test('fails closed when a pre-existing ignored nested .git regular file changes', async (t) => {
  const repo = await createRepository(t);
  const contract = contractFor(repo);
  const ignoredDirectory = join(repo, 'ignored');
  const nestedGitFile = join(ignoredDirectory, '.git');
  await writeFile(join(repo, '.gitignore'), 'ignored/\n');
  await mkdir(ignoredDirectory);
  await writeFile(nestedGitFile, 'baseline nested metadata-looking file\n');
  await git(repo, ['add', '.gitignore']);
  await git(repo, ['commit', '-m', 'ignore nested workspace file']);
  const baseline = await captureBaseline(contract);

  await writeFile(nestedGitFile, 'mutated nested metadata-looking file\n');
  const current = await captureBaseline(contract);
  const result = compareTrusted(contract, baseline, current);

  assert.equal(result.ok, false);
  assert.equal(hasViolation(result, 'FILE_MUTATION_NOT_ALLOWED', 'G1'), true);
  assert.equal(result.violations.find((item) => item.code === 'FILE_MUTATION_NOT_ALLOWED').observed, nestedGitFile);
});

test('fails closed when an ignored nested .git symlink changes to an escaping referent', async (t) => {
  const repo = await createRepository(t);
  const contract = contractFor(repo);
  const outside = await mkdtemp(join(workspaceRoot, '.snapshot-nested-git-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const ignoredDirectory = join(repo, 'ignored');
  const nestedGitLink = join(ignoredDirectory, '.git');
  await writeFile(join(repo, '.gitignore'), 'ignored/\n');
  await mkdir(ignoredDirectory);
  await symlink('../tracked.txt', nestedGitLink);
  await git(repo, ['add', '.gitignore']);
  await git(repo, ['commit', '-m', 'ignore nested workspace symlink']);
  await captureBaseline(contract);

  await rm(nestedGitLink);
  await symlink(outside, nestedGitLink);
  await assert.rejects(
    captureBaseline(contract),
    (error) => error.diagnostics?.some((diagnostic) => diagnostic.code === 'SYMLINK_ESCAPES_TARGET_ROOT'
      && diagnostic.entry === 'G1'
      && diagnostic.field === 'target'),
  );
});

test('excludes only the linked worktree root .git file from the inventory', async (t) => {
  const main = await createRepository(t);
  const linkedParent = await mkdtemp(join(workspaceRoot, '.snapshot-linked-parent-'));
  const linked = join(linkedParent, 'worktree');
  t.after(async () => {
    await git(main, ['worktree', 'remove', '--force', linked]).catch(() => undefined);
    await rm(linkedParent, { recursive: true, force: true });
  });
  await git(main, ['worktree', 'add', '-b', 'codex/linked-snapshot', linked]);
  const snapshot = await captureBaseline(contractFor(linked, {
    preflight: [{ id: 'G1', type: 'git', target: linked, require_branch: 'codex/linked-snapshot', require_clean: false }],
  }));

  const gitEntry = snapshot.entries.find((entry) => entry.id === 'G1');
  assert.equal((await readFile(join(linked, '.git'), 'utf8')).startsWith('gitdir: '), true);
  assert.equal(gitEntry.inventory.entries.some((entry) => entry.path === '.git'), false);
});
