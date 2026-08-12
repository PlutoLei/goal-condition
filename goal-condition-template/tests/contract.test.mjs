import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  readContract, validateContract, canonicalJson, contractHash, renderPreview,
} from '../scripts/lib/contract.mjs';

const fixtureUrl = new URL('./fixtures/valid-contract.json', import.meta.url);
const valid = JSON.parse(await readFile(fixtureUrl, 'utf8'));
const schema = JSON.parse(await readFile(new URL('../schema/run-contract.schema.json', import.meta.url), 'utf8'));
const execFile = promisify(execFileCallback);
const repositoryRoot = resolve(import.meta.dirname, '../..');

test('valid contract has no diagnostics', () => {
  assert.deepEqual(validateContract(valid), []);
});

test('objective is one string and unknown fields fail closed', () => {
  assert.ok(validateContract({ ...valid, objective: ['goal-a', 'goal-b'] })
    .some((x) => x.path === 'objective'));
  assert.ok(validateContract({ ...valid, surprise: true })
    .some((x) => x.code === 'UNKNOWN_FIELD'));
});

test('physical constraints require mechanism and verifier', () => {
  const broken = structuredClone(valid);
  broken.constraints[0] = {
    id: 'C1', rule: 'Do not mutate the protected asset', enforcement: 'physical',
    mechanism: '', verify: '',
  };
  assert.deepEqual(
    validateContract(broken).map((x) => x.path),
    ['constraints[0].mechanism', 'constraints[0].verify'],
  );
});

test('budget is accepted only when its provenance is explicit', () => {
  assert.ok(validateContract({ ...valid, budget: { max_tokens: 9000 } })
    .some((x) => x.path === 'budget.user_provided'));
  assert.deepEqual(validateContract({
    ...valid, budget: { user_provided: true, max_tokens: 9000 },
  }), []);
});

test('execution_permissions is a closed-world Claude-only authorization surface', () => {
  const execution_permissions = {
    bash_prefixes: ['npm test', 'git add'],
    webfetch_domains: ['cloud.langfuse.com'],
    skills: ['langfuse'],
    additional_read_roots: ['/opt/goal-condition-example/reference'],
  };
  assert.deepEqual(validateContract({ ...valid, runtime: 'claude', execution_permissions }), []);

  const unknown = structuredClone(execution_permissions);
  unknown.surprise = ['Bash'];
  assert.ok(validateContract({ ...valid, runtime: 'claude', execution_permissions: unknown })
    .some((x) => x.code === 'UNKNOWN_FIELD' && x.path.startsWith('execution_permissions.')));

  for (const [field, value] of [
    ['bash_prefixes', ['']],
    ['bash_prefixes', ['npm test) Bash(rm -rf /)']],
    ['webfetch_domains', [42]],
    ['webfetch_domains', ['safe.example\nWebFetch(domain:evil.example)']],
    ['skills', 'langfuse'],
    ['additional_read_roots', ['relative/path']],
  ]) {
    const changed = structuredClone(execution_permissions);
    changed[field] = value;
    assert.ok(validateContract({ ...valid, runtime: 'claude', execution_permissions: changed })
      .some((x) => x.path.startsWith(`execution_permissions.${field}`)), field);
  }

  const codex = validateContract({ ...valid, runtime: 'codex', execution_permissions });
  assert.ok(codex.some((x) => x.code === 'CLAUDE_EXECUTION_PERMISSIONS_ONLY'));

  const hostileTarget = structuredClone(valid);
  hostileTarget.runtime = 'claude';
  hostileTarget.target_roots[0] = '/opt/work) Bash(evil';
  assert.ok(validateContract(hostileTarget)
    .some((x) => x.code === 'PERMISSION_SPECIFIER_UNREPRESENTABLE' && x.path === 'target_roots[0]'));

  assert.ok(Object.hasOwn(schema.properties, 'execution_permissions'));
  assert.equal(schema.$defs.executionPermissions.additionalProperties, false);
  assert.ok(schema.allOf.some((entry) => entry.if?.required?.includes('execution_permissions')
    && entry.then?.properties?.runtime?.const === 'claude'));
});

// ③（re-review round 1）：max_turns 是轮数，小数没有可执行语义。实测 max_turns=0.5 会让 CLI 的
// --max-turns 被 Math.floor 成 0 **且** Stop hook 的 maxBlocks 同时成 0——零轮直接停机、hook 永不
// block，两处一起退化成「什么都不做」而不是 fail-closed。在 validate 层拒是唯一不撒谎的处置：
// 在函数里补 Math.max(1, …) 等于把用户写的 0.5 悄悄涨成 1，凭空发明一个用户没给的预算。
test('a fractional max_turns is rejected at validation time, and only max_turns', () => {
  for (const turns of [0.5, 0.999, 2.5]) {
    const diagnostics = validateContract({ ...valid, budget: { user_provided: true, max_turns: turns } });
    assert.deepEqual(diagnostics.map((x) => x.path), ['budget.max_turns']);
    assert.equal(diagnostics[0].code, 'BUDGET_TURNS_INTEGER_REQUIRED');
  }
  assert.deepEqual(validateContract({ ...valid, budget: { user_provided: true, max_turns: 5 } }), []);

  // 分钟与费用本就该允许小数（半分钟、按量计价的零头），不能被这条闸误伤。
  assert.deepEqual(validateContract({
    ...valid, budget: { user_provided: true, max_minutes: 0.5, max_cost_usd: 1.25 },
  }), []);

  // 非正数仍走原来那条 diagnostic，不因为新增整数闸而变成两条或换 code。
  assert.equal(
    validateContract({ ...valid, budget: { user_provided: true, max_turns: 0 } })[0].code,
    'POSITIVE_NUMBER_REQUIRED',
  );

  // 公开 schema 与本仓 validator 必须对同一条规则口径一致——schema 是 compiler 读的声明，
  // 两边漂了就会出现「照 schema 写的 contract 在 validate 层莫名被拒」。
  assert.equal(schema.$defs.budget.properties.max_turns.type, 'integer');
});

test('content-bound context entries reject temporary paths and duplicate IDs', () => {
  const temporary = structuredClone(valid);
  temporary.context_sources[0].path = '/private/tmp/context.md';
  assert.ok(validateContract(temporary).some((x) => x.code === 'TEMP_CONTEXT'));
  const duplicate = structuredClone(valid);
  duplicate.judgment_criteria[0].id = duplicate.context_sources[0].id;
  assert.ok(validateContract(duplicate).some((x) => x.code === 'DUPLICATE_ID'));
});

test('content sources are closed-world path and lowercase SHA-256 bindings', () => {
  for (const context of [
    '/opt/goal-condition-example/worktree/context.md',
    { id: 'CTX2', path: '/opt/goal-condition-example/worktree/context.md' },
    { id: 'CTX2', path: '/opt/goal-condition-example/worktree/context.md', sha256: 'A'.repeat(64) },
    { id: 'CTX2', path: '/opt/goal-condition-example/worktree/context.md', sha256: '2'.repeat(64), extra: true },
  ]) {
    const changed = { ...valid, context_sources: [context] };
    assert.ok(validateContract(changed).length > 0);
  }
});

test('lexically normalizes policy paths before rejecting temporary aliases', () => {
  for (const pathname of [
    '/var/../var/folders/private/context.md',
    '/private/tmp/context.md',
    '/var/folders/private/context.md',
    '/tmp/context.md',
  ]) {
    const changed = structuredClone(valid);
    changed.context_sources[0].path = pathname;
    assert.ok(validateContract(changed).some((x) => x.code === 'TEMP_CONTEXT'), pathname);
  }

  const target = structuredClone(valid);
  target.target_roots[0] = '/var/../tmp/worktree';
  assert.ok(validateContract(target).some((x) => x.code === 'TEMP_PATH'));
});

test('target roots reject temporary paths without checking the filesystem', () => {
  const temporary = { ...valid, target_roots: ['/tmp/goal-condition-example'] };
  assert.ok(validateContract(temporary).some((x) => x.code === 'TEMP_PATH'));
});

test('entry IDs are unique across the complete contract', () => {
  const duplicate = structuredClone(valid);
  duplicate.postflight[0].id = 'S1';
  assert.ok(validateContract(duplicate).some((x) => x.code === 'DUPLICATE_ID'));
});

test('machine commands require argv and reject shell fields', () => {
  const broken = structuredClone(valid);
  broken.postflight[0] = {
    id: 'V1', type: 'command', cwd: '/tmp/worktree', shell: 'npm test',
  };
  assert.ok(validateContract(broken).some((x) => x.path === 'postflight[0].argv'));
  assert.ok(validateContract(broken).some((x) => x.code === 'UNKNOWN_FIELD'));
});

test('canonical preview preserves punctuation without shell interpolation', () => {
  const dangerous = '$' + '3.69';
  const changed = { ...valid, objective: `中文 'single' "double" \\ ${dangerous}` };
  assert.equal(JSON.parse(canonicalJson(changed)).objective, changed.objective);
  assert.equal(contractHash(changed), contractHash(JSON.parse(canonicalJson(changed))));
  assert.match(renderPreview(changed), new RegExp(contractHash(changed)));
  assert.ok(renderPreview(changed).includes(changed.objective));
});

function completePreviewContract() {
  return {
    version: 1,
    runtime: 'claude',
    objective: 'preview-objective-a',
    context_sources: [{
      id: 'CTX-preview-a',
      path: '/opt/preview/worktree-a/context-a.md',
      sha256: 'a'.repeat(64),
    }],
    target_roots: ['/opt/preview/worktree-a'],
    judgment_criteria: [{ id: 'J-preview-a', rule: 'judgment-rule-a', why: 'judgment-why-a' }],
    success_criteria: [{ id: 'S-preview-a', command: 'success-command-a', expected: 'success-expected-a' }],
    constraints: [{
      id: 'C-preview-a', rule: 'constraint-rule-a', enforcement: 'physical',
      mechanism: 'mechanism-a', verify: 'constraint-verify-a',
    }],
    allowed_mutations: {
      files: ['/opt/preview/worktree-a/file-a'],
      git: ['commit'],
      external: ['external-a'],
    },
    execution_permissions: {
      bash_prefixes: ['npm test'],
      webfetch_domains: ['example.com'],
      skills: ['review'],
      additional_read_roots: ['/opt/preview/reference-a'],
    },
    budget: {
      user_provided: true,
      max_turns: 11,
      max_minutes: 22,
      max_tokens: 3333,
      max_cost_usd: 44,
    },
    preflight: [
      {
        id: 'P-git-a', type: 'git', target: '/opt/preview/worktree-a',
        require_branch: 'branch-a', require_clean: true, require_upstream: true,
      },
      { id: 'P-path-a', type: 'path', target: '/opt/preview/worktree-a/file-a', require: 'file' },
      {
        id: 'P-command-a', type: 'command', cwd: '/opt/preview/worktree-a',
        argv: ['tool-a', 'arg-a'], requires_env: ['ENV_A'], capture: 'hash',
      },
    ],
    postflight: [{
      id: 'V-command-a', type: 'command', cwd: '/opt/preview/worktree-a',
      argv: ['verify-a', 'arg-v-a'], requires_env: ['ENV_V_A'], capture: 'text',
    }],
  };
}

test('preview includes the authoritative canonical JSON contract verbatim', () => {
  const contract = completePreviewContract();
  assert.ok(renderPreview(contract).includes(canonicalJson(contract)));
});

test('every material contract field remains visible and hash-bound in preview', () => {
  const original = completePreviewContract();
  const cases = [
    ['version', (x) => { x.version = 2; }, '"version":2'],
    ['runtime', (x) => { x.runtime = 'codex'; }, '"runtime":"codex"'],
    ['objective', (x) => { x.objective = 'preview-objective-b'; }, '"objective":"preview-objective-b"'],
    ['context id', (x) => { x.context_sources[0].id = 'CTX-preview-b'; }, '"id":"CTX-preview-b"'],
    ['context path', (x) => { x.context_sources[0].path = '/opt/preview/worktree-a/context-b.md'; }, '"path":"/opt/preview/worktree-a/context-b.md"'],
    ['context hash', (x) => { x.context_sources[0].sha256 = 'b'.repeat(64); }, `"sha256":"${'b'.repeat(64)}"`],
    ['target_roots', (x) => { x.target_roots[0] = '/opt/preview/worktree-b'; }, '"target_roots":["/opt/preview/worktree-b"]'],
    ['execution bash', (x) => { x.execution_permissions.bash_prefixes[0] = 'npm run test'; }, '"bash_prefixes":["npm run test"]'],
    ['execution web', (x) => { x.execution_permissions.webfetch_domains[0] = 'api.example.com'; }, '"webfetch_domains":["api.example.com"]'],
    ['execution skill', (x) => { x.execution_permissions.skills[0] = 'security-review'; }, '"skills":["security-review"]'],
    ['execution read root', (x) => { x.execution_permissions.additional_read_roots[0] = '/opt/preview/reference-b'; }, '"additional_read_roots":["/opt/preview/reference-b"]'],
    ['judgment id', (x) => { x.judgment_criteria[0].id = 'J-preview-b'; }, '"id":"J-preview-b"'],
    ['judgment rule', (x) => { x.judgment_criteria[0].rule = 'judgment-rule-b'; }, '"rule":"judgment-rule-b"'],
    ['judgment why', (x) => { x.judgment_criteria[0].why = 'judgment-why-b'; }, '"why":"judgment-why-b"'],
    ['success id', (x) => { x.success_criteria[0].id = 'S-preview-b'; }, '"id":"S-preview-b"'],
    ['success command', (x) => { x.success_criteria[0].command = 'success-command-b'; }, '"command":"success-command-b"'],
    ['success expected', (x) => { x.success_criteria[0].expected = 'success-expected-b'; }, '"expected":"success-expected-b"'],
    ['constraint id', (x) => { x.constraints[0].id = 'C-preview-b'; }, '"id":"C-preview-b"'],
    ['constraint rule', (x) => { x.constraints[0].rule = 'constraint-rule-b'; }, '"rule":"constraint-rule-b"'],
    ['constraint enforcement', (x) => { x.constraints[0].enforcement = 'audit_only'; }, '"enforcement":"audit_only"'],
    ['constraint mechanism', (x) => { x.constraints[0].mechanism = 'mechanism-b'; }, '"mechanism":"mechanism-b"'],
    ['constraint verifier', (x) => { x.constraints[0].verify = 'constraint-verify-b'; }, '"verify":"constraint-verify-b"'],
    ['allowed files', (x) => { x.allowed_mutations.files[0] = '/opt/preview/worktree-a/file-b'; }, '"files":["/opt/preview/worktree-a/file-b"]'],
    ['allowed git', (x) => { x.allowed_mutations.git[0] = 'git-b'; }, '"git":["git-b"]'],
    ['allowed external', (x) => { x.allowed_mutations.external[0] = 'external-b'; }, '"external":["external-b"]'],
    ['budget provenance', (x) => { x.budget.user_provided = false; }, '"user_provided":false'],
    ['budget turns', (x) => { x.budget.max_turns = 12; }, '"max_turns":12'],
    ['budget minutes', (x) => { x.budget.max_minutes = 23; }, '"max_minutes":23'],
    ['budget tokens', (x) => { x.budget.max_tokens = 4444; }, '"max_tokens":4444'],
    ['budget cost', (x) => { x.budget.max_cost_usd = 55; }, '"max_cost_usd":55'],
    ['git preflight id', (x) => { x.preflight[0].id = 'P-git-b'; }, '"id":"P-git-b"'],
    ['git preflight type', (x) => { x.preflight[0].type = 'git-b'; }, '"type":"git-b"'],
    ['git preflight target', (x) => { x.preflight[0].target = '/opt/preview/worktree-git-b'; }, '"target":"/opt/preview/worktree-git-b"'],
    ['git branch', (x) => { x.preflight[0].require_branch = 'branch-b'; }, '"require_branch":"branch-b"'],
    ['git clean', (x) => { x.preflight[0].require_clean = false; }, '"require_clean":false'],
    ['git upstream', (x) => { x.preflight[0].require_upstream = false; }, '"require_upstream":false'],
    ['path preflight id', (x) => { x.preflight[1].id = 'P-path-b'; }, '"id":"P-path-b"'],
    ['path preflight type', (x) => { x.preflight[1].type = 'path-b'; }, '"type":"path-b"'],
    ['path preflight target', (x) => { x.preflight[1].target = '/opt/preview/worktree-a/file-c'; }, '"target":"/opt/preview/worktree-a/file-c"'],
    ['path requirement', (x) => { x.preflight[1].require = 'exists'; }, '"require":"exists"'],
    ['preflight command id', (x) => { x.preflight[2].id = 'P-command-b'; }, '"id":"P-command-b"'],
    ['preflight command type', (x) => { x.preflight[2].type = 'command-b'; }, '"type":"command-b"'],
    ['preflight command cwd', (x) => { x.preflight[2].cwd = '/opt/preview/worktree-command-b'; }, '"cwd":"/opt/preview/worktree-command-b"'],
    ['preflight command argv', (x) => { x.preflight[2].argv[0] = 'tool-b'; }, '"argv":["tool-b","arg-a"]'],
    ['preflight command env', (x) => { x.preflight[2].requires_env[0] = 'ENV_B'; }, '"requires_env":["ENV_B"]'],
    ['preflight command capture', (x) => { x.preflight[2].capture = 'text'; }, '"capture":"text"'],
    ['postflight id', (x) => { x.postflight[0].id = 'V-command-b'; }, '"id":"V-command-b"'],
    ['postflight type', (x) => { x.postflight[0].type = 'command-b'; }, '"type":"command-b"'],
    ['postflight cwd', (x) => { x.postflight[0].cwd = '/opt/preview/worktree-verify-b'; }, '"cwd":"/opt/preview/worktree-verify-b"'],
    ['postflight argv', (x) => { x.postflight[0].argv[0] = 'verify-b'; }, '"argv":["verify-b","arg-v-a"]'],
    ['postflight env', (x) => { x.postflight[0].requires_env[0] = 'ENV_V_B'; }, '"requires_env":["ENV_V_B"]'],
    ['postflight capture', (x) => { x.postflight[0].capture = 'hash'; }, '"capture":"hash"'],
  ];

  for (const [name, mutate, expectedFragment] of cases) {
    const changed = structuredClone(original);
    mutate(changed);
    assert.notEqual(contractHash(changed), contractHash(original), `${name} must change the hash`);
    assert.ok(renderPreview(changed).includes(expectedFragment), `${name} must be visible in preview`);
  }
});

test('readContract accepts only canonical JSON bytes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'goal-contract-canonical-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const canonicalPath = join(directory, 'canonical.json');
  await writeFile(canonicalPath, canonicalJson(valid));
  assert.deepEqual(await readContract(canonicalPath), valid);
});

test('readContract rejects whitespace and key-order variants with auditable diagnostics', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'goal-contract-noncanonical-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const variants = [
    `${JSON.stringify(valid, null, 2)}\n`,
    `${JSON.stringify(Object.fromEntries(Object.entries(valid).reverse()))}\n`,
    `${canonicalJson(valid)}\n`,
  ];

  for (const [index, raw] of variants.entries()) {
    const pathname = join(directory, `variant-${index}.json`);
    await writeFile(pathname, raw);
    assert.equal(contractHash(JSON.parse(raw)), contractHash(valid), 'semantic hash remains equal');
    await assert.rejects(
      readContract(pathname),
      (error) => error.code === 'CONTRACT_BYTES_NONCANONICAL'
        && error.path === 'contract_bytes'
        && error.observed
        && error.expected === 'bytes identical to canonicalJson(parsed contract)'
        && typeof error.next === 'string',
    );
  }
});

test('validator CLI surfaces the noncanonical byte diagnostic without exposing contents', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'goal-contract-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pathname = join(directory, 'contract.json');
  await writeFile(pathname, `${JSON.stringify(valid, null, 2)}\n`);

  await assert.rejects(
    execFile(process.execPath, [
      'goal-condition-template/scripts/validate-contract.mjs', '--contract', pathname, '--preview',
    ], { cwd: repositoryRoot }),
    (error) => error.code === 1
      && error.stderr.includes('CONTRACT_BYTES_NONCANONICAL contract_bytes')
      && error.stderr.includes('observed=')
      && error.stderr.includes('expected=')
      && error.stderr.includes('next=')
      && !error.stderr.includes(valid.objective),
  );
});

test('contract byte failures expose only stable codes and raw byte fingerprints', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'goal-contract-private-bytes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const canary = 'PRIVATE_CANARY_MUST_NOT_ESCAPE_7f9a';
  const privateContract = { ...valid, objective: canary };
  const variants = [
    ['malformed', Buffer.from(`${canary}{"unterminated":`), 'CONTRACT_JSON_INVALID'],
    [
      'bom',
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(canonicalJson(privateContract))]),
      'CONTRACT_BOM_FORBIDDEN',
    ],
    [
      'invalid-utf8',
      Buffer.concat([Buffer.from('{"private":"'), Buffer.from([0xff]), Buffer.from(`${canary}"}`)]),
      'CONTRACT_UTF8_INVALID',
    ],
    ['noncanonical', Buffer.from(`${JSON.stringify(privateContract, null, 2)}\n`), 'CONTRACT_BYTES_NONCANONICAL'],
  ];

  for (const [name, raw, code] of variants) {
    const pathname = join(directory, `${name}.json`);
    await writeFile(pathname, raw);
    const safeObserved = `sha256=${createHash('sha256').update(raw).digest('hex')} bytes=${raw.length}`;
    await assert.rejects(readContract(pathname), (error) => {
      const diagnosticText = [
        error.message, error.code, error.path, error.observed, error.expected, error.next,
      ].join(' ');
      return error.code === code
        && error.path === 'contract_bytes'
        && error.observed === safeObserved
        && !diagnosticText.includes(canary)
        && !diagnosticText.includes('PRIVATE_CANARY');
    }, name);

    await assert.rejects(
      execFile(process.execPath, [
        'goal-condition-template/scripts/validate-contract.mjs', '--contract', pathname, '--preview',
      ], { cwd: repositoryRoot }),
      (error) => error.code === 1
        && error.stderr.includes(`${code} contract_bytes`)
        && error.stderr.includes(`observed=${JSON.stringify(safeObserved)}`)
        && !error.stderr.includes(canary)
        && !error.stderr.includes('PRIVATE_CANARY'),
      `${name} CLI`,
    );
  }
});

test('semantic validation diagnostics fingerprint every user-controlled canary', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'goal-contract-private-semantics-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const canaries = {
    key: 'UNKNOWN_KEY_CANARY_91a2',
    value: 'UNKNOWN_VALUE_CANARY_82b3',
    id: 'ID_CANARY_73c4',
    path: '/opt/PATH_CANARY_64d5/worktree',
    enum: 'ENUM_CANARY_55e6',
  };
  const invalid = structuredClone(valid);
  invalid[canaries.key] = canaries.value;
  invalid.runtime = canaries.enum;
  invalid.context_sources[0].id = canaries.id;
  invalid.judgment_criteria[0].id = canaries.id;
  invalid.context_sources[0].path = canaries.path;
  invalid.context_sources[0].sha256 = canaries.value;
  invalid.allowed_mutations.files = [canaries.path];
  const pathname = join(directory, 'invalid.json');
  await writeFile(pathname, canonicalJson(invalid));

  const diagnostics = validateContract(invalid);
  const serialized = JSON.stringify(diagnostics);
  for (const canary of Object.values(canaries)) assert.equal(serialized.includes(canary), false, canary);
  assert.ok(diagnostics.every((item) => item.code && item.path && item.observed && item.expected && item.next));
  assert.ok(diagnostics.some((item) => item.code === 'UNKNOWN_FIELD' && item.path.includes('unknown_fields[')));

  await assert.rejects(
    execFile(process.execPath, [
      'goal-condition-template/scripts/validate-contract.mjs', '--contract', pathname,
    ], { cwd: repositoryRoot }),
    (error) => {
      for (const canary of Object.values(canaries)) {
        if (error.stderr.includes(canary) || error.stdout.includes(canary)) return false;
      }
      return error.code === 1 && error.stderr.includes('UNKNOWN_FIELD');
    },
  );
});
