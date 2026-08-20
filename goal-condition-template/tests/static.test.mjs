import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { REQUIRED_CORE_FILES, PROFILE_PATH } from '../scripts/lib/installer.mjs';
import { CLAUDE_CAPABILITY_FLAGS } from '../scripts/lib/claude-capability.mjs';

const repositoryRoot = resolve(import.meta.dirname, '../..');
const templateRoot = join(repositoryRoot, 'goal-condition-template');
const skillPath = join(templateRoot, 'SKILL.md');
const boundarySkillPath = join(repositoryRoot, 'boundary-design/SKILL.md');
const referencesRoot = join(templateRoot, 'references');
const requiredDescription = '当用户要把会话收口成一段可直接交给原生 /goal 的 condition 时使用；也在用户显式点名高危任务要审计留痕时，把任务或边界包编译成可确认、可验证的 Claude Code 或 Codex goal 运行契约。';

function read(pathname) {
  return existsSync(pathname) ? readFileSync(pathname, 'utf8') : '';
}

// 从 open paren 起按括号配平取出实参列表原文；跳过字符串、模板串与注释，避免其中的括号错配。
// 返回 null 表示括号不配平（源码本身有问题，调用方按失败处理）。
function callArguments(source, openParenIndex) {
  let depth = 0;
  for (let index = openParenIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === '/' && source[index + 1] === '/') {
      index = source.indexOf('\n', index);
      if (index === -1) return null;
    } else if (char === '/' && source[index + 1] === '*') {
      index = source.indexOf('*/', index + 2);
      if (index === -1) return null;
      index += 1;
    } else if (char === "'" || char === '"' || char === '`') {
      const quote = char;
      index += 1;
      while (index < source.length && source[index] !== quote) {
        index += source[index] === '\\' ? 2 : 1;
      }
      if (index >= source.length) return null;
    } else if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(openParenIndex + 1, index);
    }
  }
  return null;
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

// 主路径是「编译一段 condition 交给用户自己敲 /goal」，契约轨只在用户显式点名高危任务时进入。
// 这条钉住优先级本身：契约轨的细节最厚、最容易在后续编辑里重新爬回开头，把轻任务又拖进
// hash 确认与快照流程——2026-08-14 真实会话里连续三次误入契约轨，正是那次的制度性修复。
test('core skill leads with the condition path and gates the contract lane behind explicit opt-in', () => {
  const skill = read(skillPath);
  const conditionHeading = skill.indexOf('## 主路径：把会话收口成一段 condition');
  const contractHeading = skill.indexOf('## 例外通道：run contract');
  assert.ok(conditionHeading > 0, 'core skill lost the condition compilation path');
  assert.ok(contractHeading > conditionHeading, 'the contract lane must not precede the condition path');
  for (const term of [
    '单一可度量终态', '陈述检查方式', '要紧的约束', '停止条款',
    '不写操作步骤', '只在用户显式点名时进入', '默认永不建议、永不自动升级',
    // 交付要求：编译完直接进剪贴板，且与展示的那份逐字一致——用户不该再手工框选复制。
    // 光有「逐字一致」这句是空头承诺：必须同时规定不经 shell 解释的传输方式与回读校验，
    // 否则 `echo "…" | pbcopy` 会在 `$`、反引号上把字节改掉，而用户是盲粘，无人发现。
    'pbcopy', '逐字一致', 'heredoc', 'pbpaste', 'SHA-256',
  ]) {
    assert.ok(skill.includes(term), `condition path is missing ${term}`);
  }
  // 评估器只看 transcript 这条事实必须留在正文：它决定 condition 要写「贴出来」而不是「确保成立」。
  assert.ok(skill.includes('只看 transcript'), 'core skill no longer states the evaluator input boundary');
});

// G4（2026-08-14）：launch/resume 实际接受五个认证 flag，缺任一就 UNCERTIFIED，而 usage 一行没列，
// 操作员对着四条泛化红无从下手。usage 与 COMMANDS 的 allowed 表必须同步，否则文档又会悄悄落后。
test('launcher usage documents the capability flags that launch and resume actually accept', () => {
  const launcher = read(join(templateRoot, 'scripts/launch.mjs'));
  const usageBlock = launcher.slice(launcher.indexOf('function usage()'), launcher.indexOf('export function parseArgs'));
  assert.ok(usageBlock.length > 0, 'launcher usage block not found');
  // 断言必须按命令分段。整段 includes 会被 certify-claude-* 的 usage 行喂饱——那两行本来就带
  // --source/--auth-mode/--auth-context-id/--expected-manifest-digest，于是把 launch/resume 两行的
  // flag 删光测试照样全绿，只有 --capability-state 是它们独有的（2026-08-15 并行审变异实测）。
  const commandRegion = (command) => {
    const start = usageBlock.indexOf(`node scripts/launch.mjs ${command} `);
    assert.notEqual(start, -1, `usage does not document the ${command} command`);
    const next = usageBlock.indexOf('node scripts/launch.mjs ', start + 1);
    return usageBlock.slice(start, next === -1 ? undefined : next);
  };
  for (const command of ['launch', 'resume']) {
    const region = commandRegion(command);
    for (const flag of [...CLAUDE_CAPABILITY_FLAGS, '--expected-manifest-digest']) {
      assert.ok(region.includes(flag), `${command} usage does not document ${flag}`);
    }
  }
  // 缺 flag 不静默降级这件事也要写在 usage 里：它决定操作员看到 UNCERTIFIED 时的第一反应。
  assert.ok(usageBlock.includes('CLAUDE_CAPABILITY_UNCERTIFIED'), 'usage does not state the uncertified failure mode');

  // 单一真相源要机械成立：COMMANDS 的 allowed 表若漏掉某个 capability flag，parseArgs 会直接以
  // usage 拒收该 flag，操作员既传不进去又被判为缺失，launch/resume 永久 UNCERTIFIED 且无解。
  const commandsBlock = launcher.slice(launcher.indexOf('const COMMANDS'), launcher.indexOf('function usage()'));
  for (const command of ['launch', 'resume']) {
    const start = commandsBlock.indexOf(`  ${command}: {`);
    assert.notEqual(start, -1, `COMMANDS is missing the ${command} entry`);
    const entry = commandsBlock.slice(start, commandsBlock.indexOf('},', start));
    for (const flag of CLAUDE_CAPABILITY_FLAGS) {
      assert.ok(entry.includes(`'${flag}'`), `COMMANDS.${command}.allowed does not accept ${flag}`);
    }
  }
});

// 与上面那条 phase 断言同族：认证的 adapter lane 在单测里整个被 runAdapterLane fake 掉，
// 离线覆盖不到它的真实调用形状，只能静态钉。这条钉的是「每次认证 run 落在自己的空目录」——
// 旧实现只按 (state_root, contract hash) 派生，而 contract bytes 不含被认证的 release 身份，
// 于是认证下一个 release 会带着上一轮的 thread.json / candidate.json 起跑，报出与真实原因
// 无关的 candidate_rejected（2026-08-14 实战两次必败，归档目录后立刻通过）。
test('certification derives a per-run state directory instead of reusing the previous run residue', () => {
  const source = read(join(templateRoot, 'scripts/lib/claude-certification.mjs'));
  const marker = source.indexOf('const stateDir = stateDirFor(');
  assert.notEqual(marker, -1, 'certification no longer derives an adapter state directory');
  const args = callArguments(source, source.indexOf('(', marker + 'const stateDir = stateDirFor'.length));
  assert.ok(args !== null, 'unbalanced stateDirFor call in claude-certification');
  assert.match(args, /controller:\s*`claude-certification\/\$\{runId\}`/,
    'the certification state directory must be scoped by run id');
  // 末段必须仍是 contract hash：runners/claude.mjs 用 basename(stateDir) 与 binding.contractHash
  // 交叉校验，把 run 维度加在末段会让每次 launch 直接判不匹配。
  // 必须锚定整个属性值，不能只做子串匹配：`contractHash: runtimeContractHash + '-' + runId` 能通过
  // 子串版断言，而它正是紧邻注释声称要钉死的那条变异——真跑时 basename 变成 `<hash>-<uuid>`，
  // runners/claude.mjs 的 binding 交叉校验必然命中，认证永久不可用而单测全绿（2026-08-20 并行审实测）。
  assert.match(args, /contractHash:\s*runtimeContractHash\s*,/,
    'the state directory basename must stay exactly the contract hash');
  // runId 进了路径，就必须挡住路径穿越——它可由 dependencies.runId 注入。
  assert.match(source, /RUN_ID_INVALID/, 'the run id used in a path must be validated');
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

test('Codex controlled execution detail stays in linked references and Grill stays out of runtime', () => {
  const skill = read(skillPath);
  const adapter = read(join(referencesRoot, 'adapters/codex.md'));
  const protocol = read(join(referencesRoot, 'codex-goal-session-v2.md'));
  assert.match(skill, /\]\(references\/adapters\/codex\.md(?:#[^)]+)?\)/);
  assert.match(skill, /\]\(references\/codex-goal-session-v2\.md(?:#[^)]+)?\)/);
  assert.ok(skill.split('\n').length <= 201, 'SKILL.md must contain at most 200 lines');
  assert.match(adapter, /^## GoalSession v2 受控执行面$/m);
  assert.match(protocol, /完整输入直接编译，不运行 Grill/);
  assert.match(skill, /Brainstorm\/Grill 只用于设计前或对本 skill 做压力测试/);
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
  assert.ok(skill.includes('Codex: GoalSession v2 only'));
  assert.ok(skill.includes('Compile Goal+Authority+Design → Preview → Confirm(authorization_hash)'));
  assert.ok(skill.includes('→ Prepare Attempt → Launch → Verify → Revise/Next Attempt → Finalize → Close'));
  assert.ok(skill.includes('Claude: Compile shared run contract → Validate → Preview → Confirm(contract hash)'));
  assert.ok(skill.includes('→ Preflight → Launch(adapter) → Postflight → Close'));
  for (const term of [
    'single objective', 'stable context', 'judgment_criteria', 'success_criteria',
    'constraints', 'physical', 'audit_only', 'allowed_mutations', 'preflight',
    'postflight', 'budget', 'user_provided', 'hash',
  ]) {
    assert.ok(skill.includes(term), `core skill is missing ${term}`);
  }
});

test('Codex production guidance exposes only GoalSession v2 and one-way migration', () => {
  const skill = read(skillPath);
  const protocol = read(join(referencesRoot, 'codex-goal-session-v2.md'));
  const adapter = read(join(referencesRoot, 'adapters/codex.md'));
  const production = `${skill}\n${protocol}\n${adapter}`;
  for (const term of [
    'Codex: GoalSession v2 only', 'disabled', 'canary', 'enabled',
    'migrate-v1', 'AttemptManifest', '不得回退到 Codex v1',
  ]) {
    assert.ok(production.includes(term), `V2-only guidance is missing ${term}`);
  }
  for (const retired of [
    'legacy Codex', 'Claude/legacy', 'shadow 保留 v1 live',
    '已有 v1 task 默认继续 legacy', '只有用户明确 Adopt 才迁移',
  ]) {
    assert.equal(production.includes(retired), false, `retired Codex route remains documented: ${retired}`);
  }
});

test('Codex production guidance defines the canonical controller store and isolated overrides', () => {
  const skill = read(skillPath);
  const protocol = read(join(referencesRoot, 'codex-goal-session-v2.md'));
  const adapter = read(join(referencesRoot, 'adapters/codex.md'));
  const production = `${skill}\n${protocol}\n${adapter}`;
  assert.ok(
    REQUIRED_CORE_FILES.includes('codex-controller/src/state-root.mjs'),
    'release inventory is missing the canonical state-root resolver',
  );
  for (const term of [
    'GOAL_CONDITION_CODEX_STATE_ROOT',
    'XDG_STATE_HOME',
    '.local/state/goal-condition/codex-v2',
    '独立 deployment namespace',
    '独立 rollout',
    'controller 生成',
    '128-bit',
    'request_id',
    'creation receipt',
    'CREATION_REQUEST_CONFLICT',
  ]) {
    assert.ok(production.includes(term), `canonical controller-store guidance is missing ${term}`);
  }
  assert.match(protocol, /普通命令.*省略 `--state-root`/);
  assert.match(production, /无效.*fail closed/);
  assert.match(protocol, /`resume`.*只持久化.*显式调用 `launch`/);
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
    'references/adapters/codex.md', 'references/codex-goal-session-v2.md',
    'schema/run-contract.schema.json',
    'scripts/validate-contract.mjs', 'scripts/snapshot.mjs', 'scripts/install.mjs',
    'scripts/lib/contract.mjs', 'scripts/lib/snapshot.mjs',
    'scripts/lib/installer.mjs', 'scripts/lib/permission-specifier.mjs',
    'scripts/lib/runner-common.mjs',
    'scripts/lib/runtime-surfaces.mjs', 'scripts/lib/workflow.mjs',
    'scripts/launch.mjs', 'scripts/lib/adapters/claude.mjs', 'scripts/lib/adapters/codex.mjs',
    'scripts/lib/claude-capability.mjs', 'scripts/lib/claude-certification.mjs',
    'scripts/lib/claude-permissions.mjs',
    'scripts/lib/runners/claude.mjs',
    'scripts/lib/runners/codex.mjs',
    'codex-controller/src/migration.mjs', 'codex-controller/src/attempt.mjs',
    'codex-controller/src/capabilities.mjs', 'codex-controller/src/execution.mjs',
    'codex-controller/src/recovery.mjs', 'codex-controller/src/release.mjs',
    'codex-controller/src/rollout.mjs',
    'codex-controller/src/verification.mjs',
  ]) {
    assert.ok(readme.includes(term), `README is missing required release member ${term}`);
  }
});

test('public docs separate release integrity from runtime certification end to end', () => {
  const readme = read(join(repositoryRoot, 'README.md'));
  const skill = read(skillPath);
  const runContract = read(join(referencesRoot, 'run-contract.md'));
  const claude = read(join(referencesRoot, 'adapters/claude.md'));
  const codex = read(join(referencesRoot, 'adapters/codex.md'));
  const protocol = read(join(referencesRoot, 'codex-goal-session-v2.md'));
  const production = `${readme}\n${skill}\n${runContract}\n${claude}\n${codex}\n${protocol}`;
  for (const term of [
    'release integrity', 'runtime certification', 'stage', 'activate',
    'Candidate', 'Certified', 'certify-claude-prepare', 'certify-claude-run',
    '完整 preview', 'exact hash', 'Git checkout', 'external manifest v2',
    'schema-v5', 'runtime_surface_digest', '实现、测试、review、Claude live certification',
    'GOAL_CONDITION_EXPECTED_MANIFEST_DIGEST',
  ]) {
    assert.ok(production.includes(term), `runtime certification docs are missing ${term}`);
  }
  assert.match(readme, /Codex runtime surface digest/);
  assert.match(readme, /source checkout.*不能.*staged|checkout.*不能.*installed/s);
  assert.doesNotMatch(readme, /receipt 绑定当前安装 `manifestDigest`，因此 release 切换后必须重新 canary/);
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

test('launcher is a thin dispatcher and runtime attempt lifecycles stay runtime-owned', () => {
  const launcher = read(join(templateRoot, 'scripts', 'launch.mjs'));
  const common = read(join(templateRoot, 'scripts', 'lib', 'runner-common.mjs'));
  const claude = read(join(templateRoot, 'scripts', 'lib', 'runners', 'claude.mjs'));
  const codex = read(join(templateRoot, 'scripts', 'lib', 'runners', 'codex.mjs'));

  assert.match(launcher, /import\('.\/lib\/runners\/claude\.mjs'\)/);
  assert.match(launcher, /import\('.\/lib\/runners\/codex\.mjs'\)/);
  assert.doesNotMatch(launcher, /^import .*\/(?:runners\/(?:claude|codex)|claude-(?:capability|certification))\.mjs';$/m);
  assert.doesNotMatch(launcher, /function (?:prepareClaude|runClaudeAttempt|runCodexLaunch|runCodexResume)\b/);
  assert.doesNotMatch(common, /adapters\/(?:claude|codex)\.mjs/);
  assert.match(claude, /export async function runClaudeAttempt\b/);
  assert.doesNotMatch(claude, /runCodex(?:Launch|Resume|Finalize|Close)/);
  assert.match(codex, /export async function runCodexLaunch\b/);
  assert.doesNotMatch(codex, /runClaude(?:Attempt|Readback)/);
});

test('Codex controller and shared dispatcher do not statically load the other runtime surface', () => {
  const launcher = read(join(templateRoot, 'scripts', 'launch.mjs'));
  const controller = read(join(templateRoot, 'codex-controller', 'src', 'cli.mjs'));
  assert.doesNotMatch(controller, /scripts\/launch\.mjs/);
  assert.match(controller, /scripts\/lib\/runner-common\.mjs/);
  assert.match(controller, /scripts\/lib\/runners\/codex\.mjs/);
  assert.doesNotMatch(controller, /runners\/claude\.mjs|claude-(?:capability|certification)\.mjs/);
  assert.doesNotMatch(launcher, /^export \* from .*\/(?:runners|claude-)/m);
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
    'authorization_hash', 'AttemptManifest', 'baseline_digest', 'postflight', 'remaining_work',
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

test('every captureSnapshot call site declares its phase explicitly', () => {
  // 真实教训（2026-08-13）：claude-certification 的 defaultCaptureBaseline / defaultVerifyBaseline
  // 裸调 captureSnapshot(contract)，而 phase 是 fail-closed 必填——离线测试全部注入 fake capture，
  // 真实 certify-claude-run 因此在 HEAD 上永远 Snapshot preflight failed。离线 fake 盖不住的
  // 调用形状约束，用静态断言钉死。
  // 判据必须钉在实参列表上，不能用定长滑窗 + includes：滑窗会让裸调用从注释、相邻调用或无关
  // 对象字面量里「借」到 phase:，而那正是本断言要拦的形状（2026-08-14 并行审三引擎同时命中）。
  // 扫描范围同理必须覆盖全部 runtime 源码——只扫 scripts/ 时 codex-controller/src 的调用点在
  // 断言之外，测试名却写着 every。
  const roots = ['scripts', 'codex-controller/src'];
  const sourceFiles = roots.flatMap((relativeRoot) => coreCandidateFiles(join(templateRoot, relativeRoot))
    .filter((name) => name.endsWith('.mjs'))
    .map((name) => join(templateRoot, relativeRoot, name)));
  let callSites = 0;
  for (const pathname of sourceFiles) {
    const source = read(pathname);
    // 只认调用位置：函数声明处的同名 token 不是调用点（否则形参表会被当成实参表）。
    for (const match of source.matchAll(/\bcaptureSnapshot\s*\(/g)) {
      if (/\bfunction\s+$/.test(source.slice(Math.max(0, match.index - 24), match.index))) continue;
      callSites += 1;
      const args = callArguments(source, match.index + match[0].length - 1);
      assert.ok(args !== null, `unbalanced captureSnapshot call in ${pathname}`);
      assert.match(args, /(^|[,{\s])phase:/, `captureSnapshot call without explicit phase in ${pathname}`);
    }
  }
  assert.ok(callSites >= 7, `expected to find the known captureSnapshot call sites, found ${callSites}`);
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
