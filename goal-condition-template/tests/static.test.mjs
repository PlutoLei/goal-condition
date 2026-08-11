import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { REQUIRED_CORE_FILES, PROFILE_PATH } from '../scripts/lib/installer.mjs';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const templateRoot = join(repositoryRoot, 'goal-condition-template');
const skillPath = join(templateRoot, 'SKILL.md');
const boundarySkillPath = join(repositoryRoot, 'boundary-design/SKILL.md');
const referencesRoot = join(templateRoot, 'references');
const requiredDescription = '当用户要求把任务、边界包或已有完成条件编译成可确认、可验证的 Claude Code 或 Codex goal 运行契约时使用。';

function read(pathname) {
  return existsSync(pathname) ? readFileSync(pathname, 'utf8') : '';
}

function markdownFiles(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const pathname = join(root, entry.name);
    if (entry.isDirectory()) return markdownFiles(pathname);
    return entry.isFile() && entry.name.endsWith('.md') ? [pathname] : [];
  });
}

function coreCandidateFiles(root, current = '') {
  if (!existsSync(join(root, current))) return [];
  return readdirSync(join(root, current), { withFileTypes: true }).flatMap((entry) => {
    const relativePath = current ? `${current}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return coreCandidateFiles(root, relativePath);
    return entry.isFile() ? [relativePath] : [];
  });
}

function frontmatter(markdown) {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match, 'SKILL.md must begin with YAML frontmatter');
  return Object.fromEntries(match[1].split('\n').map((line) => {
    const separator = line.indexOf(':');
    assert.notEqual(separator, -1, `invalid frontmatter line: ${line}`);
    return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
  }));
}

test('core skill has the exact public identity and stays compact', () => {
  const skill = read(skillPath);
  const metadata = frontmatter(skill);
  assert.equal(metadata.name, 'goal-condition');
  assert.equal(metadata.description, requiredDescription);
  assert.ok(skill.split('\n').length <= 201, 'SKILL.md must contain at most 200 lines');
});

test('core skill exposes every required reference and every relative Markdown link resolves', () => {
  const required = [
    'references/run-contract.md',
    'references/adapters/claude.md',
    'references/adapters/codex.md',
    'references/anchors-and-rules.md',
    'schema/run-contract.schema.json',
    'scripts/validate-contract.mjs',
    'scripts/snapshot.mjs',
  ];
  for (const relativePath of required) {
    assert.ok(existsSync(join(templateRoot, relativePath)), `missing required reference: ${relativePath}`);
  }

  for (const pathname of [skillPath, ...markdownFiles(referencesRoot)]) {
    const markdown = read(pathname);
    for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1].split('#')[0];
      if (!target || /^(?:https?:|#)/.test(target)) continue;
      assert.ok(existsSync(resolve(dirname(pathname), target)), `${pathname} has a broken link: ${target}`);
    }
  }
});

test('Codex shadow control-plane detail stays in the linked adapter reference', () => {
  const skill = read(skillPath);
  const adapter = read(join(referencesRoot, 'adapters/codex.md'));
  assert.match(skill, /\]\(references\/adapters\/codex\.md(?:#[^)]+)?\)/);
  assert.ok(skill.split('\n').length <= 201, 'SKILL.md must contain at most 200 lines');
  assert.match(adapter, /^## GoalSession v2 Shadow 控制面$/m);
});

// REQUIRED_CORE_FILES 既是「安装闭包该包含什么」的声明又是校验时的对照表——自建型自证：
// 常量少一项，install.test.mjs 的旧字面 fixture 清单不会跟着变小，测试照样全绿（见
// task-16-report.md 盲区 2 的 15 项逐一实测）。这里换一个独立于常量本身的真相源——checkout 里
// scripts/、references/、schema/ 下真实存在的文件树（readdirSync，不读常量）——对账，drift 在
// 任何一个方向都报错。
//
// 这是 REQUIRED_CORE_FILES 目前唯一的独立守护，且两个方向（常量少一项 / 常量多一项 ghost）都只
// 靠它抓：多一项这条路径此前由 install.test.mjs 的 fixture 顺带拦住（ghost 文件不在 fixture 里，
// 会踩 CORE_SOURCE_MISSING），但 fixture 改成从 REQUIRED_CORE_FILES 派生之后，那份偶然覆盖跟着
// 消失了——这是有意的架构收敛（集中真相源优于分散的偶然覆盖），不要为了保留那条路径把 fixture
// 改回硬编码。install.test.mjs 那条「manifest 与常量互为全集」的断言看着像是同一件事的第二道防线，
// 实际不是：那条断言两侧都读同一个 REQUIRED_CORE_FILES，是自证的，测不出常量本身漂移。删掉这条
// 磁盘对账测试，就等于原地恢复 task-16-report.md 记录的「删 12/15 项零反应」那个盲区。
test('REQUIRED_CORE_FILES matches every script, schema, and adapter reference actually shipped on disk', () => {
  const codexControllerCore = [
    'codex-controller/package.json',
    ...coreCandidateFiles(templateRoot, 'codex-controller/schema'),
    ...coreCandidateFiles(templateRoot, 'codex-controller/src'),
  ];
  const onDisk = [
    ...(existsSync(skillPath) ? ['SKILL.md'] : []),
    ...['scripts', 'references', 'schema'].flatMap((dir) => coreCandidateFiles(templateRoot, dir)),
    ...codexControllerCore,
  ].filter((relativePath) => relativePath !== PROFILE_PATH);
  assert.deepEqual(
    [...onDisk].sort(),
    [...REQUIRED_CORE_FILES].sort(),
    'REQUIRED_CORE_FILES has drifted from the scripts/references/schema files shipped in goal-condition-template',
  );
});

test('loader-read Markdown contains no positional-dollar expansion or private data', () => {
  const dollarNumber = new RegExp('\\' + '$' + '[0-9]');
  const userPath = '/' + 'Users' + '/';
  const homePath = '/' + 'home' + '/';
  const credentialTerms = ['SEC' + 'RET', 'TOK' + 'EN', 'API' + '_' + 'KEY'];
  const keyPrefix = 'sk' + '-';
  const privateData = new RegExp([
    userPath,
    homePath,
    `\\b(?:[A-Z][A-Z0-9_]*_)?(?:${credentialTerms.join('|')})\\b`,
    `\\b${keyPrefix}[A-Za-z0-9]+`,
    '\\b[Dd]ataset[_ -]?[Ii][Dd]\\b',
  ].join('|'));
  const representativeForbidden = [
    userPath + 'private-file',
    homePath + 'private-file',
    'SERVICE_' + credentialTerms[1],
    keyPrefix + 'example',
    'Dataset_' + 'Id',
  ];
  for (const sample of representativeForbidden) {
    assert.match(sample, privateData, `private-data detector missed representative sample: ${sample}`);
  }
  const files = [skillPath, boundarySkillPath, ...markdownFiles(referencesRoot)];
  for (const pathname of files) {
    const markdown = read(pathname);
    assert.doesNotMatch(markdown, dollarNumber, `${pathname} contains a dollar-number loader hazard`);
    assert.doesNotMatch(markdown, privateData, `${pathname} contains private or credential-like data`);
  }
});

test('core skill preserves the complete fail-closed workflow and package', () => {
  const skill = read(skillPath);
  assert.ok(skill.includes('Classify → Compile → Validate → Preview → Confirm(hash)\n→ Preflight → Launch(adapter) → Postflight → Close'));
  for (const term of [
    'single objective', 'stable context', 'judgment_criteria', 'success_criteria',
    'constraints', 'physical', 'audit_only', 'allowed_mutations', 'preflight',
    'postflight', 'budget', 'user_provided', 'hash',
  ]) {
    assert.ok(skill.includes(term), `core skill is missing ${term}`);
  }
});

// R-4：状态机对可续类与终局类红 postflight 返回的**都是** `reject`，真正的分流在
// classifyPostflightRed，而那是编排器要自己调的一步。SKILL.md 此前只说「其余状态按 diagnostic 报告
// 实际差异和下一步」——照这句字面实现的编排器拿到 reject 就去报告，resume 永远不会被发起。整条续跑
// 路径长期没有真实运行覆盖，这个措辞缺口是原因之一。
test('core skill routes a red postflight through the resumable split instead of stopping at reject', () => {
  const skill = read(skillPath);
  for (const term of ['classifyPostflightRed', '可续类', '终局类', 'adapter 的 resume', '可续类续跑']) {
    assert.ok(skill.includes(term), `core skill no longer routes reds to resume: missing ${term}`);
  }
  // 注入内容的边界也要在主流程里出现一次，否则「馈回 diagnostic」会被读成「把红项输出贴回去」。
  assert.ok(skill.includes('不得包含执行体产出的字节'), 'core skill is missing the injection boundary');
});

test('run-contract reference documents the trusted external baseline digest handshake', () => {
  const reference = read(join(referencesRoot, 'run-contract.md'));
  for (const term of [
    'baseline_digest', '--expected-baseline-digest', '可信编排状态',
    'expectedBaselineDigest', 'code', 'path', 'observed', 'expected', 'next',
  ]) {
    assert.ok(reference.includes(term), `run-contract.md is missing ${term}`);
  }
});

test('public docs expose the external release trust root and complete required core', () => {
  const readme = read(join(repositoryRoot, 'README.md'));
  const reference = read(join(referencesRoot, 'run-contract.md'));
  for (const term of ['manifestDigest', '--expected-manifest-digest', 'external']) {
    assert.ok(`${readme}\n${reference}`.includes(term), `release trust docs are missing ${term}`);
  }
  for (const term of [
    'SKILL.md', 'references/run-contract.md', 'references/adapters/claude.md',
    'references/adapters/codex.md', 'schema/run-contract.schema.json',
    'scripts/validate-contract.mjs', 'scripts/snapshot.mjs', 'scripts/install.mjs',
    'scripts/lib/contract.mjs', 'scripts/lib/snapshot.mjs',
    'scripts/lib/installer.mjs', 'scripts/lib/workflow.mjs',
    'scripts/launch.mjs', 'scripts/lib/adapters/claude.mjs', 'scripts/lib/adapters/codex.mjs',
  ]) {
    assert.ok(readme.includes(term), `README is missing required release member ${term}`);
  }
});

test('every current release verify example requires the external manifest digest', () => {
  const markdownSources = [
    join(repositoryRoot, 'README.md'),
    join(referencesRoot, 'run-contract.md'),
    join(repositoryRoot, 'docs/superpowers/plans/2026-08-05-goal-condition-cross-runtime-core.md'),
  ];
  for (const pathname of markdownSources) {
    for (const block of read(pathname).matchAll(/```(?:text|bash)?\n([\s\S]*?)```/g)) {
      if (!/(?:install\.mjs\s+verify|verify\s+--release)/.test(block[1])) continue;
      assert.match(block[1], /--expected-manifest-digest\s+\S+/, `${pathname} has a stale release verify example`);
    }
  }
  assert.match(
    read(join(templateRoot, 'scripts/install.mjs')),
    /install\.mjs verify --release PATH --expected-manifest-digest DIGEST/,
  );
});

// usage 曾一律写 goal-condition-template/scripts/…，但已安装 release 根目录下只有 scripts/，
// 照着复制粘贴得到的是 Cannot find module。钉的是 release 成员表而不是字串，也不是 checkout 里的
// 存在性——后者会放过 tests/、spikes/ 这类「checkout 里有、但根本不进 release」的路径。
test('every shipped CLI usage names a path that ships in the release', () => {
  for (const script of [
    'scripts/launch.mjs', 'scripts/snapshot.mjs',
    'scripts/install.mjs', 'scripts/validate-contract.mjs',
  ]) {
    const referenced = [...read(join(templateRoot, script)).matchAll(/node (\S+\.mjs)/g)]
      .map((match) => match[1]);
    assert.ok(referenced.length > 0, `${script} usage names no script path`);
    for (const pathname of referenced) {
      assert.ok(
        REQUIRED_CORE_FILES.includes(pathname),
        `${script} usage names ${pathname}, which is not a release member`,
      );
    }
  }
});

test('core and run-contract docs bind launch to canonical artifact bytes and complete preview', () => {
  const skill = read(skillPath);
  const reference = read(join(referencesRoot, 'run-contract.md'));
  for (const term of ['canonical JSON bytes', 'byte-identical', 'authoritative canonical JSON']) {
    assert.ok(`${skill}\n${reference}`.includes(term), `canonical artifact docs are missing ${term}`);
  }
});

test('core and run-contract docs define privacy-safe contract byte diagnostics', () => {
  const skill = read(skillPath);
  const reference = read(join(referencesRoot, 'run-contract.md'));
  for (const term of [
    'CONTRACT_JSON_INVALID', 'CONTRACT_BOM_FORBIDDEN', 'CONTRACT_UTF8_INVALID',
    'CONTRACT_BYTES_NONCANONICAL', 'raw SHA-256', 'byte length', 'parser message',
  ]) {
    assert.ok(`${skill}\n${reference}`.includes(term), `contract byte privacy docs are missing ${term}`);
  }
});

test('anchors profile is data-free and contains verifier and source references only', () => {
  const anchors = read(join(referencesRoot, 'anchors-and-rules.md'));
  assert.ok(anchors.includes('核验命令'));
  assert.ok(anchors.includes('来源'));
  assert.doesNotMatch(anchors, /当前基线数字|<N>\s*tests?|\b\d+\s*tests?|基线\s*(?:数|计数)/i);
});

test('Claude adapter is runtime-specific and fail closed', () => {
  const adapter = read(join(referencesRoot, 'adapters/claude.md'));
  for (const term of [
    '/goal', '--disallowedTools', '--settings', 'subtype', 'is_error',
    'terminal_reason', 'permission_denials', 'baseline_digest', 'runBinding',
    'preflightEvidence', 'postflightEvidence', 'controller-owned',
    'Stop hook', 'JSON decision', '4000', 'disableAllHooks', '--resume',
    '21', '2.1.223', 'realpath',
  ]) {
    assert.ok(adapter.includes(term), `Claude adapter is missing ${term}`);
  }
  assert.doesNotMatch(adapter, /\b(?:create_goal|get_goal|update_goal)\b/);
});

test('Codex adapter is runtime-specific and preserves goal-tool semantics', () => {
  const adapter = read(join(referencesRoot, 'adapters/codex.md'));
  for (const term of [
    'create_goal', 'get_goal', 'update_goal', 'token_budget', 'audit_only',
    'confirmed hash', 'baseline_digest', 'postflight', 'remaining_work',
    'ready_for_postflight', 'finalize_runtime', 'verify_runtime', 'runBinding',
    'postflightEvidence', 'finalizationReceipt', 'runtimeReadback',
    'controller-owned', 'untrusted runtimeResult',
    'thread/goal/set', 'thread/goal/get', 'thread/goal/clear', 'turn/start',
    'thread/inject_items', 'ephemeral', 'tokenBudget', 'updatedAt',
    'budgetLimited', 'usageLimited', 'auth-copy', 'app-server',
  ]) {
    assert.ok(adapter.includes(term), `Codex adapter is missing ${term}`);
  }
  assert.doesNotMatch(adapter, /claude\s+-p/);
});

// 第二次 codex 真实冒烟改准的三处文档。它们都是「文档说的和实测不符」，红检只能钉在文本上——
// 但钉的是**结论**（哪条路径可靠、哪条断言被证伪），不是措辞排版。
test('Codex adapter documents the controller-side guardrails as adapter constants, not contract budget', () => {
  const adapter = read(join(referencesRoot, 'adapters/codex.md'));
  // P-2：护栏是 adapter 常量。写成 contract 字段就等于让一份 contract 关掉自己的刹车。
  assert.match(adapter, /MAX_TURNS_PER_ATTEMPT/);
  assert.match(adapter, /MAX_TOKENS_PER_ATTEMPT/);
  assert.match(adapter, /不是 contract 预算/);
  assert.match(adapter, /取\*\*更紧\*\*的一侧/);
  // 两条明确的不做：不解析执行体输出（信任模型）、不做无文件变更熔断（会误杀只读轮次）。
  assert.match(adapter, /不解析执行体输出/);
  assert.match(adapter, /连续 N 轮无文件变更即熔断/);
  // review M-1 症状②：护栏量的是 per-attempt 增量，contract budget 是整个 run 的累计预算，
  // 两者口径不同——不写明就会被读成「护栏在替 contract 记账」。
  assert.match(adapter, /护栏与 contract 预算不是同一个口径/);
  assert.match(adapter, /本 attempt 的增量/);
  // review M-1 症状①：抬预算这根杆子必须写明护栏会认，否则操作员抬完还被旧值掐。
  assert.match(adapter, /--raise-token-budget N` 是\*\*用户明确确认要抬预算\*\*的载体/);
});

test('Codex adapter scopes blocked to a healthy tool surface and drops the disproven no-op claim', () => {
  const adapter = read(join(referencesRoot, 'adapters/codex.md'));
  // P-3：blocked 的上报通道与被阻断的执行通道共用实现，工具面一坏它跟着坏——文档此前把它写成
  // 一条无条件可靠的终局路径，实测 goal 会一直停在 active。
  // 两处各自钉死：六态表那一格与 blocked 小节都要说到，钉一处会被另一处的同类措辞盖过去
  // （第一版红检就栽在这上面：改坏小节，断言却匹配到了表格那一行）。
  assert.match(adapter, /这条路径只在工具面健康时可达/);            // 六态表
  assert.match(adapter, /只在工具面健康时才是一条可靠的终局路径/);   // blocked 小节
  assert.match(adapter, /唯一的阻断上报通道与被阻断的执行通道/);
  // P-5：complete → complete 的 set 不是 no-op，实测 updatedAt 照样推进。旧断言必须消失，
  // 而归因实现不因此弱化——序列号那一重仍留在同一段里（钉整句，不钉「单调序列号」这个词：
  // 它在别的段落也出现，钉词等于让这条红检永远不响）。
  assert.doesNotMatch(adapter, /在状态维度是 no-op/);
  assert.match(adapter, /`1786257720` 推进到 `1786257793`/);
  assert.match(adapter, /并叠加下文的单调序列号/);
});

test('boundary-design emits platform-neutral run-contract vocabulary', () => {
  const boundarySkill = read(boundarySkillPath);
  for (const term of [
    'run contract', 'constraint', 'judgment criterion', 'success criterion',
    'physical', 'audit_only', '四判断题', '表达形式阶梯',
  ]) {
    assert.ok(boundarySkill.includes(term), `boundary-design is missing ${term}`);
  }
  assert.doesNotMatch(boundarySkill, /\/goal|claude\s+-p/i);
});
