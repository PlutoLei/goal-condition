// controller 执行入口层：state 目录 / attempt 计数 / 红项分类 / claude prepare。
// 执行豁口在这，纯函数判定留在 scripts/lib/adapters/*.mjs（本文件不判定，只采集与落盘）。

import { execFile as execFileCallback } from 'node:child_process';
import {
  appendFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, writeSync,
  constants,
} from 'node:fs';
import {
  appendFile, chmod, lstat, mkdir, open, readdir, readFile, rm, stat, writeFile,
} from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import {
  basename, dirname, isAbsolute, join,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  assertLaunchable, buildSettings, buildStopHook, launchSpec, normalizeTerminal, resumeSpec,
} from './lib/adapters/claude.mjs';
import {
  assertLaunchable as assertCodexLaunchable, assertResumedSession, assertSetReturnedStatus,
  bindControllerTurnText, CODEX_SANDBOX_MODE, GoalRpcClient, normalizeTerminal as normalizeCodexTerminal,
  noteworthyNotification, resumeRpcOps, TURN_BOUNDARY_METHODS, verifyFinalizeAttribution,
} from './lib/adapters/codex.mjs';
import { contractHash, readContract, ContractArtifactError } from './lib/contract.mjs';
import { runtimeTerminalState } from './lib/workflow.mjs';

const execFile = promisify(execFileCallback);

const SHA256 = /^[0-9a-f]{64}$/;

function sha256Text(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function nativeTurnInputSha256(turn) {
  const userMessages = Array.isArray(turn?.items)
    ? turn.items.filter((item) => item?.type === 'userMessage') : [];
  const content = userMessages[0]?.content;
  if (userMessages.length !== 1
    || !Array.isArray(content)
    || content.length !== 1
    || content[0]?.type !== 'text'
    || typeof content[0]?.text !== 'string') return null;
  return sha256Text(content[0].text);
}

function summarizeNativeTurn(turn) {
  return {
    id: turn?.id,
    status: turn?.status ?? null,
    input_sha256: nativeTurnInputSha256(turn),
  };
}

// §6：一次逻辑 run = 1 首发 + ≤2 续跑。
export const MAX_AUTO_RESUMES = 2;

// 路径归一。同一个目录在两侧可能各拿到 symlink 的一边（contract 写字面路径、服务端回真实路径，
// 或反过来），逐字比较会把同一个目录判成两个。归一化失败（路径不存在、入参不是字符串）时退回原值，
// 绝不抛——调用方要么在比字符串，要么已经准备好接住一个非字符串并如实判红。
function canonicalPath(pathname) {
  try {
    return realpathSync(pathname);
  } catch {
    return pathname;
  }
}

// targetRoots/additionalReadRoots 是 launch 时刻的全量 canonical 授权面（V2'）：cwd 只覆盖
// target_roots[0]，第二 target root 或 read root 被 symlink 重定向时 resume 必须能对出漂移。
const CLAUDE_POINTER_KEYS = Object.freeze([
  'additionalReadRoots', 'cwd', 'promptSha256', 'sessionId', 'targetRoots', 'transcriptPath',
]);
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Controller claims are read through a descriptor with O_NOFOLLOW and must be private regular files.
// This avoids the lstat-then-read race and makes a symlink/hardlink an invalid claim, never an invitation
// to replace or follow it.
export async function readControllerJsonNoFollow(pathname, nofollow = constants.O_NOFOLLOW) {
  if (typeof nofollow !== 'number') {
    // 平台无 O_NOFOLLOW（如 Windows）：仍要区分「不存在」与「存在但无法安全 no-follow 读」，
    // 否则首次 launch 把「无 thread.json」误报成「存在但损坏」，工具在该平台完全不可用且诊断误导
    // 操作员去修一个并不存在的损坏文件（V3，两方收敛，latent）。
    if (!existsSync(pathname)) return { ok: false, missing: true };
    return { ok: false, missing: false };
  }
  let handle;
  try {
    handle = await open(pathname, constants.O_RDONLY | nofollow);
  } catch (error) {
    return { ok: false, missing: error?.code === 'ENOENT' };
  }
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.nlink !== 1) return { ok: false, missing: false };
    try {
      return { ok: true, missing: false, value: JSON.parse(await handle.readFile('utf8')) };
    } catch {
      return { ok: false, missing: false };
    }
  } finally {
    await handle.close();
  }
}

function isAbsolutePathList(value) {
  return Array.isArray(value)
    && value.every((entry) => typeof entry === 'string' && isAbsolute(entry));
}

function isClaudePointer(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(CLAUDE_POINTER_KEYS)) return false;
  if (!UUID_V4.test(value.sessionId)) return false;
  if (typeof value.cwd !== 'string' || !isAbsolute(value.cwd)) return false;
  if (!HEX64.test(value.promptSha256)) return false;
  if (typeof value.transcriptPath !== 'string' || !isAbsolute(value.transcriptPath)) return false;
  if (!isAbsolutePathList(value.targetRoots) || value.targetRoots.length === 0) return false;
  if (!isAbsolutePathList(value.additionalReadRoots)) return false;
  return true;
}

async function observeTargetIdentity(pathname) {
  const st = await stat(pathname);
  if (!st.isDirectory()) throw new Error('target root is not a directory');
  return { dev: st.dev, ino: st.ino };
}

// settings 文件几十 KB 就顶天了；cap 挡的是 symlink→/dev/zero 这类「读到死」的形态，不是精确预算。
const PROJECT_SETTINGS_SIZE_CAP = 128 * 1024;

// target root 内容是攻击者可控面，这里的读必须守 readControllerJsonNoFollow 同款描述符纪律：
// O_NOFOLLOW（symlink 即拒）+ O_NONBLOCK（FIFO 的 open 不再等 writer 挂死）+ fstat regular file
// + size cap。与 controller claim 的差别在语义：那边「读不了」= 无效 claim，这边「读不了」=
// 保守 flag——无法证明它不含 permissions（fail-closed）。
async function readProjectSettingsText(pathname) {
  if (typeof constants.O_NOFOLLOW !== 'number') {
    // 平台无 O_NOFOLLOW（如 Windows）：存在但无法安全 no-follow 读 → 保守 flag；不存在照常跳过。
    if (!existsSync(pathname)) return { missing: true };
    return { unreadable: true };
  }
  let handle;
  try {
    handle = await open(pathname, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    // ENOENT 是唯一的「没有这个文件」形态；ELOOP（symlink 被 O_NOFOLLOW 拒）、EACCES 等都是
    // 「有东西但读不了」，保守 flag。
    if (error?.code === 'ENOENT') return { missing: true };
    return { unreadable: true };
  }
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.size > PROJECT_SETTINGS_SIZE_CAP) return { unreadable: true };
    return { text: await handle.readFile('utf8') };
  } catch {
    return { unreadable: true };
  } finally {
    await handle.close();
  }
}

// settings.local.json 自 CLI 2.1.211 起从 enclosing git root 加载（官方文档明文；2.1.229 deny 探针
// 双向实证：git root 的 local.json 对子目录 cwd 生效，settings.json 只看 cwd、不向上）。.git 条目
// 按存在性判定（目录=普通 repo、文件=worktree/submodule）；与 git rev-parse 的边缘差异（GIT_DIR
// 覆写、bare repo）按保守方向接受——这里只决定「多扫哪个目录」，不决定放行。
function findEnclosingGitRoot(pathname) {
  let dir = pathname;
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Claude runtime union 掉预存 .claude/settings*.json 的 permissions 段——spike 实证预存 allow 真会
// 生效，使 effective 授权面超出 controller 编译的 allow-list（V4）。扫描范围精确跟随加载面：每个
// target root 自身的 settings.json/settings.local.json，加 enclosing git root（若在 root 之外）的
// settings.local.json（CR-5——target root 是仓库子目录时加载面越出 target root；git root 的
// settings.json 实测不加载，扫它会把「祖先仓库带无关 project settings」的合法形态永久判红）。
// 含 permissions 段（或读不安全/解析不出）的文件交 assertLaunchable 落红；只设 model/hooks 的
// 无害配置不含 permissions、不进清单。
async function scanProjectSettingsWithPermissions(targetRoots) {
  const flagged = [];
  const checked = new Set();
  const check = async (pathname) => {
    if (checked.has(pathname)) return;
    checked.add(pathname);
    const read = await readProjectSettingsText(pathname);
    if (read.missing) return;
    if (read.text === undefined) {
      flagged.push(pathname);
      return;
    }
    try {
      const parsed = JSON.parse(read.text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'permissions' in parsed) {
        flagged.push(pathname);
      }
    } catch {
      flagged.push(pathname);
    }
  };
  for (const root of targetRoots) {
    for (const file of ['settings.json', 'settings.local.json']) {
      await check(join(root, '.claude', file));
    }
    const gitRoot = findEnclosingGitRoot(root);
    if (gitRoot !== null && gitRoot !== root) {
      await check(join(gitRoot, '.claude', 'settings.local.json'));
    }
  }
  return flagged;
}

export function stateDirFor({ stateRoot, controller = 'default', contractHash }) {
  return join(stateRoot, controller, contractHash);
}

export async function initStateDir(dir) {
  await mkdir(dir, { recursive: true });
  await chmod(dir, 0o700);
  await mkdir(join(dir, 'attempts'), { recursive: true });
}

async function maxExistingAttempt(stateDir) {
  let entries;
  try {
    entries = await readdir(join(stateDir, 'attempts'));
  } catch {
    return 0;
  }
  const numbers = entries.filter((name) => /^[0-9]+$/.test(name)).map(Number);
  return numbers.length === 0 ? 0 : Math.max(...numbers);
}

// 「号没占上」与「执行器跑挂了」是两类事件：前者是进程级失败（exit 1、stdout 空、诊断走
// stderr），后者是终局报告（exit 3）。codex 侧的占号落在 withCodexClient 回调体内，那里的外层
// catch 会把一切异常吞成 terminal_report——靠这个类型把占号失败摘出来重抛，exit 1 语义才保得住。
// 不覆写 name：面向操作员的身份写在 message 的 ATTEMPT_LIMIT_EXCEEDED / ATTEMPT_SLOT_TAKEN
// 前缀里，这个类只是归一路径上的内部控制流标记。
export class AttemptClaimError extends Error {}

function attemptLimitError(stateDir, current) {
  const ceiling = 1 + MAX_AUTO_RESUMES;
  return new AttemptClaimError('ATTEMPT_LIMIT_EXCEEDED entry=attempts field=attempt_number '
    + `observed=attempt ${current + 1} requested with ${current} already spent in ${stateDir} `
    + `expected=at most ${ceiling} (1 launch + MAX_AUTO_RESUMES ${MAX_AUTO_RESUMES}) `
    + 'next=this run has spent its attempt budget and neither prepare nor close clears the counter, so either '
    + 'start a fresh run under a different --controller name (prepare then writes a new state dir with a full '
    + `budget) or, once no run is live, remove ${join(stateDir, 'attempts')}`);
}

// 只读的天花板预检：不占号、不落任何盘上痕迹，因此可以放在所有起飞动作之前。配额耗尽是
// 「操作员必须换 --controller 重开」的死局，没必要先复制一遍凭证、起一个 app-server 再发现。
// 它不替代 nextAttempt 里的同一判定——那条才是并发下的裁决者，这条只是把死局提前到零副作用处。
export async function assertAttemptBudgetLeft(stateDir) {
  const current = await maxExistingAttempt(stateDir);
  if (current + 1 > 1 + MAX_AUTO_RESUMES) throw attemptLimitError(stateDir, current);
}

// O_EXCL 原子占位：崩溃后重启的进程重新扫 attempts/ 现有最大序号即可续上，不需要额外的
// 崩溃恢复状态机。超过 1 首发 + MAX_AUTO_RESUMES 续跑即 fail-closed 拒绝（attempt 超限 fault
// injection 靠这条 throw）。
//
// 调用点必须落在所有前置闸之后（claude.md 的计数口径是「真实跑过的轮次」）——占位是
// 不可撤销的：prepare 与 close 都不清 attempts/，配额一旦烧完，这份 contract 在这个 state
// 目录上就永久起不来。诊断因此按本仓的 observed/expected/next 三件套写，next 给出真实出路。
export async function nextAttempt(stateDir) {
  const current = await maxExistingAttempt(stateDir);
  const next = current + 1;
  if (next > 1 + MAX_AUTO_RESUMES) throw attemptLimitError(stateDir, current);
  try {
    await writeFile(join(stateDir, 'attempts', String(next)), '', { flag: 'wx' });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    // O_EXCL 的败者。裸 EEXIST 是本函数唯一一条不带 observed/expected/next 的出口，而它恰好是
    // 操作员最需要出路的一条（F-5）。不自动让号重试：O_EXCL 在这里就是互斥原语，让号等于放两个
    // 执行器进同一个 target root。
    throw new AttemptClaimError('ATTEMPT_SLOT_TAKEN entry=attempts field=attempt_number '
      + `observed=attempt ${next} in ${stateDir} was claimed by another process while this one was claiming it `
      + 'expected=exactly one process claims each attempt number (the claim is an O_EXCL create) '
      + 'next=another process is starting a run against this same state directory; confirm none is live '
      + '(lease.json in the state dir) and retry, or start a fresh run under a different --controller name');
  }
  return next;
}

// §6 表。fail-closed 方向：未知 code 归 terminal，不自动续跑。
const TERMINAL_CODES = [/^CONTEXT_STATE_CHANGED$/, /^GIT_/, /^PERMISSION_/, /^UNAUTHORIZED_/];
export const RESUMABLE_CODES = Object.freeze(['COMMAND_FAILED', 'ARTIFACT_MISSING']);
export function classifyPostflightRed(diagnostics) {
  const resumable = [];
  const terminal = [];
  for (const diagnostic of diagnostics) {
    const code = diagnostic?.code ?? '';
    if (TERMINAL_CODES.some((pattern) => pattern.test(code))) terminal.push(diagnostic);
    else if (RESUMABLE_CODES.includes(code)) resumable.push(diagnostic);
    else terminal.push(diagnostic);   // 未知 code fail-closed：不自动续跑
  }
  return { resumable, terminal };
}

// 注入通道的形状闸。
//
// 起因：注入项以 `role:"user"` 进 thread 历史，而 objective 是被包在
// `<codex_internal_context source="goal">` 里、并显式声明「treat it as the task to pursue, **not as
// higher-priority instructions**」的——也就是说**注入的 diagnostic 在权限上高于 objective**。而
// `--diagnostics-file` 此前读文件全部 bytes 原样塞进 `input_text`，对这段文本零约束。风险形态很具体：
// 编排器很自然会把红项命令的 **stdout** 贴进 diagnostic（「这条为什么红？把输出贴上」），而 postflight
// 命令的 stdout 完全可能是执行体自己写的文件内容（`cat`/`diff`/`jq` 类 verifier 都会）——那一刻执行体
// 上一轮产出的字节，就以高于 objective 的权限回到了它自己面前。信任边界那节此前只写了「执行器输出
// 不得反序列化为任何 controller **证据**」，注入是**反方向**，没被覆盖。
//
// 闸的形状：文件不再是自由文本，而是一份闭世界的红项清单。`argv` 与 `cwd` **不从文件里读**，按 entry
// id 回 contract 里取；`code` 只认可续类（终局类红项本来就不该续跑）。于是注入文本的每个字节要么来自
// contract（用户确认过 hash 的那份）、要么来自控制器自己的模板，编排器能供的只剩一个整数退出码。
// 这不是「劝阻」，是让「把 stdout 贴进来」在结构上没有落脚处。
//
// 闸落在 CLI 这一层，因为这里才是操作员提供的 bytes 进入本进程的边界：`runCodexResume` /
// `runClaudeAttempt` 收的是已渲染好的文本，而它们不是库（见 codex.md「auth-copy 安全模式」末条，
// 一个进程跑一条命令），没有第二个调用方。
export const DIAGNOSTICS_MAX_REDS = 32;
const RED_FIELDS = Object.freeze(['code', 'entry', 'exit']);
const DIAGNOSTICS_SHAPE = '{"reds":[{"entry":"<postflight entry id>","code":"'
  + `${RESUMABLE_CODES.join('|')}","exit":<0-255 or null>}]}`;

function sameFieldSet(value, fields) {
  const keys = Object.keys(value);
  return keys.length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}

// 返回渲染好的注入文本，或一组安全的拒绝理由（reason 不回显文件内容，只说字段位置与形状）。
export function compileResumeDiagnostic({ text, contract }) {
  const refuse = (reason) => ({ ok: false, reasons: [`--diagnostics-file ${reason}; expected ${DIAGNOSTICS_SHAPE}`] });
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    return refuse('is not valid JSON');
  }
  if (document === null || typeof document !== 'object' || Array.isArray(document) || !sameFieldSet(document, ['reds'])) {
    return refuse('must be an object whose only field is "reds"');
  }
  if (!Array.isArray(document.reds) || document.reds.length === 0) {
    return refuse('must carry a non-empty "reds" array');
  }
  if (document.reds.length > DIAGNOSTICS_MAX_REDS) {
    return refuse(`carries more than ${DIAGNOSTICS_MAX_REDS} reds`);
  }
  const entries = new Map((contract?.postflight ?? []).map((entry) => [entry.id, entry]));
  const seen = new Set();
  const reds = [];
  for (const [index, red] of document.reds.entries()) {
    const at = `reds[${index}]`;
    if (red === null || typeof red !== 'object' || Array.isArray(red) || !sameFieldSet(red, RED_FIELDS)) {
      return refuse(`${at} must have exactly the fields ${RED_FIELDS.join(', ')}`);
    }
    // entry 必须是本 contract 声明过的 postflight 条目：注入文本里的命令与工作目录都从这里取，
    // 编排器点不到 contract 之外的东西。
    const entry = entries.get(red.entry);
    if (entry === undefined) return refuse(`${at}.entry does not name a postflight entry of this contract`);
    if (seen.has(red.entry)) return refuse(`${at}.entry repeats an entry already listed`);
    seen.add(red.entry);
    if (!RESUMABLE_CODES.includes(red.code)) {
      return refuse(`${at}.code is not one of the resumable codes ${RESUMABLE_CODES.join(', ')} `
        + '(terminal-class reds must stop the run, not drive a resume)');
    }
    if (red.exit !== null && !(Number.isInteger(red.exit) && red.exit >= 0 && red.exit <= 255)) {
      return refuse(`${at}.exit must be an integer in 0..255, or null when the check produced no exit code`);
    }
    // contract 的字节此前是靠「已过 validateContract」这条假设收下的，而 readContract 只做
    // BOM/UTF-8/canonical 三项**字节**检查，不校验字段——launcher 拿到的 contract 未必被 validator
    // 看过。渲染前自己核一遍这两项：核不过就拒，而不是把 `argv=undefined` 注进 thread 历史。
    if (typeof entry.cwd !== 'string' || !Array.isArray(entry.argv) || entry.argv.length === 0
      || entry.argv.some((part) => typeof part !== 'string')) {
      return refuse(`${at}.entry names a postflight entry whose cwd/argv are not the shape a validated `
        + 'contract declares, so there is nothing safe to render from it');
    }
    reds.push({
      entry: entry.id, code: red.code, exit: red.exit, argv: entry.argv, cwd: entry.cwd,
    });
  }
  return { ok: true, text: renderDiagnosticText(reds), reasons: [] };
}

// entry / argv / cwd **一律**走 JSON.stringify：contract 作者的字节里可能有换行或引号，逐字拼进去
// 会让注入文本的行结构被 contract 内容改写。entry id 曾是这行里唯一原样内插的一格——同一行的另外
// 两格转义、它不转义，是个说不出理由的例外。
function renderDiagnosticText(reds) {
  return [
    'CONTROLLER POSTFLIGHT DIAGNOSTIC',
    '',
    'The controller re-ran this contract\'s postflight checks itself. These are red:',
    '',
    ...reds.map(({
      entry, code, exit, argv, cwd,
    }) => `- ${JSON.stringify(entry)} [${code}]: argv=${JSON.stringify(argv)} cwd=${JSON.stringify(cwd)} `
      + `exit=${exit === null ? 'none' : exit}`),
    '',
    'Make every one of those checks pass, then stop. Stay inside the mutations the objective allows.',
    '',
  ].join('\n');
}

// 控制器按候选返回体的 hookExpected 累计「本应出现 Stop 事件」的轮次，再与运行次数对账；
// max-turns 硬停不触发 Stop hook，不能把那一轮误报成 hook 缺席。
export async function hookRunCount(stateDir) {
  let text;
  try {
    text = await readFile(join(stateDir, 'hook-runs.jsonl'), 'utf8');
  } catch {
    return 0;
  }
  return text.split('\n').filter((line) => line.trim().length > 0).length;
}

// 默认采集器：真实 execFile('claude', ['--version']) + lstat + sha256。测试通过 prepareClaude
// 的 collect 参数注入 stub，不真调 claude 二进制。
async function defaultCollect({ hookScriptPath }) {
  const { stdout } = await execFile('claude', ['--version']);
  const match = stdout.match(/(\d+\.\d+\.\d+)/);
  // --session-id 能力探测直接问 --help，不做版本推断（代理指标不得严于/替代直接检查）：flag
  // 何时引入无从由版本下限证明，而它现在是否存在可以直接观测。探测失败按「不存在」落盘——
  // launch 前置闸据此落红，fail closed，不把「问不出来」当「有」。
  let helpStdout = '';
  try {
    ({ stdout: helpStdout } = await execFile('claude', ['--help']));
  } catch {
    helpStdout = '';
  }
  const bytes = await readFile(hookScriptPath);
  const st = await lstat(hookScriptPath);
  return {
    claudeVersionRaw: stdout,
    claudeVersion: match ? match[1] : null,
    claudeSessionIdFlag: /--session-id\b/.test(helpStdout),
    hookMode: (st.mode & 0o7777).toString(8).padStart(4, '0'),
    hookSha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

// 幂等重写：prepareClaude 对同一 stateDir 必须可重入（如 requires_env 缺失 throw 之后，操作员
// 补齐环境变量重跑 prepare 是这条校验本身邀请的补救动作），runClaudeAttempt 也用它每轮把 settings
// 覆写回盘。因此这是一个「按路径写任意内容」的原语，绝不能原地覆写：原地写**跟着 symlink 走**
// （把 state 目录里的 settings.json 换成指向他人文件的符号链接，受害文件就会被 JSON 覆写，
// chmod 还会穿透过去改它的 mode），hardlink 那一路连 lstat 都看不出来（N3 实测两路都成立）。
// 先删再以 O_EXCL 新建把两路一起关掉——比「lstat 判是不是 symlink」彻底：落盘的永远是本目录里
// 一个新建的 regular file。删除与新建之间若有人抢先放回同名条目，wx 会 EEXIST 抛错，fail-closed。
// 顺带消掉了原先「先 chmod 0600 拿回写权限」那一步（删除只要目录写权限，不需要文件本身可写），
// 终态 mode 因此完全由 finalMode 决定，不再依赖调用历史。
async function writeReplacing(path, content, finalMode) {
  await rm(path, { force: true });
  await writeFile(path, content, { flag: 'wx' });
  if (finalMode !== undefined) await chmod(path, finalMode);
}

// 六步：见 spec §5 + task-8 brief。执行侧采集在这，纯函数判定在 adapters/claude.mjs 的
// assertLaunchable（本函数只落盘 probes，不下 ok/reasons 结论）。
export async function prepareClaude({ contract, contractPath, stateDir, collect = defaultCollect }) {
  // 1. 规范路径——S5 的 /var/folders 字面失配教训：hook/deny 全用 realpath 之后的形态。
  await initStateDir(stateDir);
  const realStateDir = realpathSync(stateDir);

  // 2. 生成并落盘 Stop hook，chmod 0500。
  const { script } = buildStopHook({ contract, stateDir: realStateDir });
  const hookScriptPath = join(realStateDir, 'stop-hook.mjs');
  await writeReplacing(hookScriptPath, script, 0o500);
  const expectedHookSha256 = createHash('sha256').update(script, 'utf8').digest('hex');

  // 3. requires_env 并集：缺一即 throw，不静默；命中的值只落 state 目录（0700/0600），不进 git/日志。
  const envNames = new Set();
  for (const entry of contract.postflight ?? []) {
    for (const name of entry.requires_env ?? []) envNames.add(name);
  }
  const missing = [...envNames].filter((name) => process.env[name] === undefined);
  if (missing.length > 0) {
    throw new Error(`requires_env missing from the launching environment: ${missing.join(', ')}`);
  }
  const envValues = Object.fromEntries([...envNames].map((name) => [name, process.env[name]]));
  const hookEnvPath = join(realStateDir, 'hook-env.json');
  await writeReplacing(hookEnvPath, JSON.stringify(envValues), 0o600);

  // 4. settings.json。contract 层只校验 raw 字符串，但进权限 DSL 的是 realpath 后的值——realpath
  // 含括号/换行时 buildSettings 会抛 assertPermissionSpecifier 的 TypeError。包成干净 ContractArtifactError，
  // 别让操作员拿到裸 TypeError（V7，DeepSeek 独有）。诊断只说形态，不回显具体路径值（隐私纪律）。
  const targetRoots = (contract.target_roots ?? []).map(canonicalPath);
  const additionalReadRoots = (contract.execution_permissions?.additional_read_roots ?? []).map(canonicalPath);
  let settings;
  try {
    settings = buildSettings({
      contract, hookScriptPath, stateDir: realStateDir, targetRoots, additionalReadRoots,
    });
  } catch (error) {
    // 只罩 assertPermissionSpecifier 的 TypeError 路径。其余 throw 是真 bug，包成权限诊断会把
    // 操作员引去改一个没毛病的 contract（V7'）——原样 rethrow。
    if (!(error instanceof TypeError)) throw error;
    throw new ContractArtifactError({
      code: 'PERMISSION_SPECIFIER_UNREPRESENTABLE',
      path: 'target_roots/execution_permissions',
      observed: 'a canonicalized path or permission value cannot be represented in the Claude permission DSL',
      expected: 'canonical paths and permission values free of parentheses, line breaks, and edge whitespace',
      next: 'adjust the offending value; note the realpath (not just the literal) is what gets compiled',
    });
  }
  const settingsPath = join(realStateDir, 'settings.json');
  await writeReplacing(settingsPath, JSON.stringify(settings, null, 2), 0o600);

  // 5. 采集 probes（spec §5「事先采集并落盘」——含原始输出，不是只留判定结论）。
  const collected = await collect({ hookScriptPath });
  const probes = {
    contractPath: contractPath ?? null,
    claudeVersionCommand: ['claude', '--version'],
    claudeVersionRaw: collected.claudeVersionRaw,
    claudeVersion: collected.claudeVersion,
    claudeHelpCommand: ['claude', '--help'],
    claudeSessionIdFlag: collected.claudeSessionIdFlag === true,
    settings,
    hookScript: {
      path: hookScriptPath, exists: true, mode: collected.hookMode, sha256: collected.hookSha256,
    },
    expectedHookSha256,
  };
  const probesPath = join(realStateDir, 'probes.json');
  // 与上面三处同走 writeReplacing：本函数四个落盘点都是「按路径写任意内容」，漏掉一个就留一个
  // 完整的 symlink/hardlink 写原语（N3）。
  await writeReplacing(probesPath, JSON.stringify(probes, null, 2));

  // 6.
  return { settingsPath, hookScriptPath, probes };
}

// claude -p 的会话 transcript 落在 ~/.claude/projects/<slug(cwd)>/<sessionId>.jsonl；slug 规则
// （绝对路径中非 [A-Za-z0-9-] 的字符一律替换成 '-'）是 CLI 内部实现、无稳定性承诺——spike S-C
// 在 2.1.228 实测确认。因此这条路径只作观测通道（readback，fail-open）：规则漂移的表现是
// 「文件不存在 → available:false」，绝不进入判定或证据链。
export function claudeTranscriptPath({ cwd, sessionId }) {
  const slug = String(cwd).replace(/[^A-Za-z0-9-]/g, '-');
  return join(homedir(), '.claude', 'projects', slug, `${sessionId}.jsonl`);
}

// 现场重新 lstat/hash hook 文件——probes.json 记的是 prepare 时刻的观测，attempt 之间可能被
// 篡改；不信任缓存值，每次 attempt 都重新采集这一项再交 assertLaunchable 判定。路径由调用方
// 从 stateDir 推出，不从 probes.json 里读（否则是在被篡改的路径上重采，等于零收益）。
async function observeHookScript(hookScriptPath) {
  try {
    const bytes = await readFile(hookScriptPath);
    const st = await lstat(hookScriptPath);
    return {
      path: hookScriptPath,
      exists: true,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      mode: (st.mode & 0o7777).toString(8).padStart(4, '0'),
    };
  } catch {
    return {
      path: hookScriptPath, exists: false, sha256: null, mode: null,
    };
  }
}

const HEX64 = /^[0-9a-f]{64}$/;

// 六步（task-9 brief，T9 裁决更新 runBinding 接入）：binding 与 stateDir 的
// hash 三方交叉（binding.contractHash 对不上 prepare 时落盘的 stateDir 末段即终局，抓的是
// 「binding 缺失/损坏/prepare 之后 contract 被换」这类漂移，execFileImpl 一次都不调）→ 现场重算
// 判定输入并合成 probes 交 assertLaunchable 前置判定（红→终局报告）→ launchSpec/resumeSpec 组 argv →
// nextAttempt 占位 → execFileImpl 采集原始 result（claude -p 非零退出/is_error 时 stdout 仍是
// result JSON，先从 error.stdout 回捞再 JSON.parse，解析不出才按进程失败终局）→ normalizeTerminal
// 归一化（ok→候选，即使 terminal_reason 是 max_turns_reached 等「未达」也如实标注为候选，不是终局；
// not ok→终局报告）。候选与终局都不做 postflight——那是主会话的独立职责。
export async function runClaudeAttempt({
  contract, stateDir, prompt, kind, diagnosticText, binding, execFileImpl = execFile,
  beforeDispatch = async () => {},
}) {
  // attempt 号只在所有前置闸全绿、真要 spawn 执行器时才占（第二次冒烟 N-2）：占位不可撤销，
  // 而前置闸拒绝的原因经常在 contract 之外（binding 笔误、claude 版本掉出 allowlist、hook 文件
  // 模式被改），改正它们不会换 contract hash，也就不会换 state 目录。占在闸前意味着三次笔误就把
  // 这份 contract 在这个 state 目录上永久锁死。它也与 claude.md 的计数口径冲突——那里定义的是
  // 「一次逻辑 run = 1 首发 + 最多 2 次续跑」，约束的是真实跑过的轮次。
  let attemptNumber = null;
  // 每个返回体都带上 attemptNumber 与本刻的 hook 运行次数；候选另带 hookExpected，控制器只把
  // hookExpected=true 的轮次计入期望值。这样既能把 hook 静默缺席（resume 未继承 --settings、
  // hook 被绕过删除）变成可验证的红，也不会把不触发 Stop 的 max-turns 硬停误算成缺席。
  // 前置闸拒绝时 attemptNumber 为 null——显式的「没有轮次可对账」，与「字段缺失」区分开。
  const finish = async (result) => ({
    ...result, attemptNumber, hookRuns: await hookRunCount(stateDir),
  });

  // binding（主会话持有的 runBinding={contractHash,baselineDigest,runId}）缺失、JSON 损坏、
  // 或 contractHash 对不上 stateDir 末段（prepare 时确认并落盘的 hash），在这一步统一 fail-closed：
  // undefined/null 的 binding?.contractHash 永远不等于真实 hex hash，天然落进这条终局报告。
  if (binding?.contractHash !== basename(stateDir)) {
    return finish({
      outcome: 'terminal_report',
      reasons: ['runBinding is missing, malformed, or does not match the state directory this attempt was prepared under'],
    });
  }

  // probes.json 与被判定的对象同在一个 0700 目录里，执行器与控制器同 uid——它能被写，就不能
  // 当作判定输入的真值源（终审 I1 实测：改一次 probes.json 即整体绕过本闸，attempt 带着攻击者
  // 的 settings 与空壳 hook 正常起飞）。因此 assertLaunchable 的五项输入里有四项在这里现场重算：
  // hook 路径与 settings 路径由 stateDir 推出（与 prepare 同一 realpath 形态）、期望 hash 由
  // contract 现场重新生成 hook 脚本再算、settings 全文现场重新生成。留在 probes.json 里读的只有
  // claudeVersion——它是一次外部进程观测，无法在纯判定路径上重放。
  const storedProbes = JSON.parse(await readFile(join(stateDir, 'probes.json'), 'utf8'));
  const realStateDir = realpathSync(stateDir);
  const hookScriptPath = join(realStateDir, 'stop-hook.mjs');
  const { script } = buildStopHook({ contract, stateDir: realStateDir });
  const expectedHookSha256 = createHash('sha256').update(script, 'utf8').digest('hex');
  const targetRoots = (contract.target_roots ?? []).map(canonicalPath);
  const additionalReadRoots = (contract.execution_permissions?.additional_read_roots ?? []).map(canonicalPath);
  let targetRootIdentities;
  let additionalReadRootIdentities;
  try {
    targetRootIdentities = await Promise.all(targetRoots.map(observeTargetIdentity));
    // additional_read_roots 进 settings.additionalDirectories，与 target root 一样是授权的目录面，
    // 必须同等绑定 device/inode 并在 spawn 前复核（V6，Codex 独有 P1）——否则替换 read-root 目录
    // 能把授权读路径重定向到无关数据，而不触发任何前置检查。
    additionalReadRootIdentities = await Promise.all(additionalReadRoots.map(observeTargetIdentity));
  } catch {
    return finish({
      outcome: 'terminal_report',
      reasons: ['a canonical target or additional read root is not a readable directory, so its launch identity cannot be bound'],
    });
  }
  let settings;
  try {
    settings = buildSettings({
      contract, hookScriptPath, stateDir: realStateDir, targetRoots, additionalReadRoots,
    });
  } catch {
    return finish({
      outcome: 'terminal_report',
      reasons: ['Claude permission settings contain an invalid permission specifier and cannot be compiled'],
    });
  }
  const settingsPath = join(realStateDir, 'settings.json');
  // hook 脚本走的是「读磁盘 bytes → 与现场重算的 sha256 比对」，settings.json 此前没有同等待遇：
  // 判定的是上一行这个内存对象，交给 claude 的却是磁盘上的 settingsPath（re-review I1b 实测：把
  // 磁盘那份的 deny 改成 [] 即可带着空 deny 合法起飞）。这里不加第二道比对，而是每次 attempt 用
  // 现场生成的这份覆写回磁盘——判定对象与被消费对象按构造相等，中间不留可篡改的窗口；顺带让
  // prepare 之后才发生的路径/内容变动不再以过期 settings 的形式残留。
  await writeReplacing(settingsPath, JSON.stringify(settings, null, 2), 0o600);
  const hookScript = await observeHookScript(hookScriptPath);
  const probes = {
    claudeVersion: storedProbes.claudeVersion,
    // 与 claudeVersion 同一待遇：一次外部进程观测，无法在纯判定路径上重放，只能从 prepare 落盘
    // 的 probes.json 里读。显式 === true 归一：旧 state 目录（探测引入前 prepare 的）缺这个字段
    // 时判 false → 前置闸红 → 重跑 prepare 即可，不烧配额。
    claudeSessionIdFlag: storedProbes.claudeSessionIdFlag === true,
    contractHash: contractHash(contract),
    // confirmedHash 现在来自主会话的 runBinding 本体（不再是 stateDir 末段——那条检查已经
    // 上移成独立的三方交叉判定），与此刻现场重算的 contractHash 对比，抓的是「prepare 之后
    // contract 对象被换了」这类漂移。baselineDigestStored 同样来自 binding：主会话是否真的把
    // baseline digest 外存到了可信编排状态，执行层不再假装替上游验证一件看不到的事实。
    confirmedHash: binding?.contractHash,
    baselineDigestStored: typeof binding?.baselineDigest === 'string' && HEX64.test(binding.baselineDigest),
    targetRoots,
    additionalReadRoots,
    projectSettingsWithPermissions: await scanProjectSettingsWithPermissions(targetRoots),
    stateDir: realStateDir,
    settings,
    expectedHookSha256,
    hookScript,
  };

  const verdict = assertLaunchable(contract, probes);
  if (!verdict.ok) {
    return finish({ outcome: 'terminal_report', reasons: verdict.reasons });
  }

  const cwd = targetRoots[0];
  const threadPath = join(realStateDir, 'thread.json');

  let spec;
  let sessionId;
  if (kind === 'launch') {
    // 一次逻辑 run 只能 claim 一个 Claude 会话。已有可读指针时再次 launch 会把 resume 坐标
    // 换成新会话，与「1 launch + ≤2 resume」和 claim 后只 readback/reconcile 的恢复模型都冲突。
    // 损坏/不可读/链接形态都意味着 claim 状态不可证明，必须显式恢复，不能覆写后另起会话。
    const prior = await readControllerJsonNoFollow(threadPath);
    if (!prior.missing) {
      return finish({
        outcome: 'terminal_report',
        reasons: [prior.ok && isClaudePointer(prior.value)
          ? 'this run already claimed a claude session; use resume or readback instead of launching again'
          : 'thread.json exists but is invalid; recover it explicitly instead of launching a second session'],
      });
    }
    // claim-before-dispatch（借 codex GoalSession v2 的 LaunchIntent 语义）：会话身份由控制器
    // 预派，resume 指针在 spawn 之前落盘（见占号后那一步）。2026-08-10 真实 run 的 resume 死锁
    // 根因就是指针落在终局校验之后——error 形态 envelope 过不了单锚，指针永不落盘。
    sessionId = randomUUID();
    spec = launchSpec({
      prompt, settingsPath, cwd, budget: contract.budget, sessionId,
    });
  } else if (kind === 'resume') {
    const prior = await readControllerJsonNoFollow(threadPath);
    if (prior.missing) {
      return finish({
        outcome: 'terminal_report',
        reasons: ['no thread.json in state dir: cannot resume without a prior session id'],
      });
    }
    if (!prior.ok || !isClaudePointer(prior.value)) {
      return finish({
        outcome: 'terminal_report',
        reasons: ['thread.json exists but is invalid; recover the controller-issued pointer before resume'],
      });
    }
    // resume 绑 launch-time cwd：pointer.cwd 是首发时的 canonical target root，与此刻重算的 cwd
    // 必须相等。symlink target root 在 launch 后被重定向时二者分叉——若仍用当前 cwd 续跑，会在新
    // 目录里复活旧会话，且 settings/deny 面（当前根）与 spawn cwd 不一致（V2）。fail-closed 拒绝。
    if (prior.value.cwd !== cwd) {
      return finish({
        outcome: 'terminal_report',
        reasons: ['target root canonical path changed since launch; refusing to resume the session in a different directory'],
      });
    }
    // cwd 只覆盖 target_roots[0]。其余 target roots 与 additional read roots 同样进 settings 的
    // 授权面（additionalDirectories），launch 后被 symlink 重定向时 cwd 检查是盲的（V2'）——
    // pointer 记的全量 launch-time canonical roots 与此刻重算值必须逐字相等。
    if (JSON.stringify(prior.value.targetRoots) !== JSON.stringify(targetRoots)
      || JSON.stringify(prior.value.additionalReadRoots) !== JSON.stringify(additionalReadRoots)) {
      return finish({
        outcome: 'terminal_report',
        reasons: ['a target or additional read root canonical path changed since launch; refusing to resume with a drifted authorization surface'],
      });
    }
    ({ sessionId } = prior.value);
    spec = resumeSpec({
      sessionId, settingsPath, diagnosticText, cwd, budget: contract.budget,
    });
  } else {
    throw new Error(`unsupported kind: ${kind}`);
  }

  // 前置闸全绿、argv 已组好，下一行就是真正的 spawn——占号的时刻在这里，不在函数开头。
  attemptNumber = await nextAttempt(stateDir);

  if (kind === 'launch') {
    // 指针先落盘再 spawn：无论终局形态如何（成功、error_max_turns、进程崩溃、stdout 不可解析），
    // resume 都有指针可用。promptSha256/transcriptPath 只供 readback 归因与观测（fail-open 通道），
    // resume 只消费 sessionId。spawn 未成功而指针已在的形态是 fail-closed 的：resume 会对不存在
    // 的会话报错、落终局报告，不会伪装成候选。
    try {
      await writeFile(threadPath, JSON.stringify({
        sessionId,
        cwd,
        promptSha256: createHash('sha256').update(prompt, 'utf8').digest('hex'),
        transcriptPath: claudeTranscriptPath({ cwd, sessionId }),
        targetRoots,
        additionalReadRoots,
      }, null, 2), { flag: 'wx', mode: 0o600 });
    } catch {
      return finish({
        outcome: 'terminal_report',
        reasons: ['thread.json was claimed concurrently or is invalid; refusing to dispatch a second session'],
      });
    }
  }

  // spawn 前的最后闸失败时释放本次 claim：launch 刚写的 pointer 指向一个从未 spawn 的 session，
  // 留着它会把下一次 launch 拒成 already-claimed、把 resume 指向不存在的会话——正常 retry 路径
  // 被毒化（PR2-3）。只在 launch 释放（resume 的 pointer 属于真实存在的旧会话，identity 红是
  // 环境问题，坐标必须保留）；attempt 号不回收——O_EXCL 计数只进不退是并发裁决的保守方向。
  const releaseUnspawnedClaim = async () => {
    if (kind === 'launch') await rm(threadPath, { force: true });
  };

  // The permission rules and cwd are bound to the same canonical roots. Recheck device/inode after
  // every async claim step and immediately before spawn so replacing a canonical directory cannot
  // redirect execution into a repository whose project settings were never denied.
  await beforeDispatch({
    cwd, targetRoots: [...targetRoots], additionalReadRoots: [...additionalReadRoots],
  });
  try {
    const rebound = async (roots, identities) => {
      for (let index = 0; index < roots.length; index += 1) {
        const current = await observeTargetIdentity(roots[index]);
        const bound = identities[index];
        if (current.dev !== bound.dev || current.ino !== bound.ino) return false;
      }
      return true;
    };
    if (!await rebound(targetRoots, targetRootIdentities)
      || !await rebound(additionalReadRoots, additionalReadRootIdentities)) {
      await releaseUnspawnedClaim();
      return finish({
        outcome: 'terminal_report',
        reasons: ['canonical root identity changed before dispatch; refusing to spawn Claude'],
      });
    }
  } catch {
    await releaseUnspawnedClaim();
    return finish({
      outcome: 'terminal_report',
      reasons: ['canonical root identity changed before dispatch; refusing to spawn Claude'],
    });
  }

  // 早扫（进 assertLaunchable 的那次）挡的是占号前的形态，便宜且不烧配额；但 claim 与
  // beforeDispatch 都是 async 步骤，之后才种进 target root 的 permissioned settings 不改目录
  // inode（identity 复核照常通过），却仍会被 Claude runtime union 进 effective 权限
  // （V4-TOCTOU）。与 identity recheck 同构：spawn 前最后一刻复扫一次。
  if ((await scanProjectSettingsWithPermissions(targetRoots)).length > 0) {
    await releaseUnspawnedClaim();
    return finish({
      outcome: 'terminal_report',
      reasons: ['a project settings file with a permissions block appeared inside a target root after the launch gate; refusing to spawn Claude'],
    });
  }

  let raw;
  try {
    const { stdout } = await execFileImpl(spec.argv[0], spec.argv.slice(1), { cwd, maxBuffer: 32 * 1024 * 1024 });
    try {
      raw = JSON.parse(stdout);
    } catch {
      return finish({ outcome: 'terminal_report', reasons: ['claude stdout is not valid JSON'] });
    }
  } catch (error) {
    // claude -p 非零退出/is_error 时 stdout 仍是 result JSON——execFile throw 时先从
    // error.stdout 回捞，解析不出才按进程失败终局（不是 stdout 非 JSON 那条理由）。
    if (typeof error?.stdout === 'string') {
      try {
        raw = JSON.parse(error.stdout);
      } catch {
        return finish({ outcome: 'terminal_report', reasons: [`claude process failed: ${error.message}`] });
      }
    } else {
      return finish({ outcome: 'terminal_report', reasons: [`claude process failed: ${error.message}`] });
    }
  }

  await writeFile(join(stateDir, 'attempts', `${attemptNumber}-result.json`), JSON.stringify(raw, null, 2));

  const normalized = normalizeTerminal(raw);
  if (!normalized.ok) {
    return finish({ outcome: 'terminal_report', reasons: normalized.reasons });
  }

  // 身份交叉核验：envelope 回显的 session_id 必须等于控制器持有的那一个（launch=预派值，
  // resume=thread.json 指针）。对不上说明候选归属存疑——fail closed 落终局，不吞进候选；
  // thread.json 保持控制器写入的值不动，执行体侧的回显永远不反向覆写指针。
  if (raw.session_id !== sessionId) {
    return finish({
      outcome: 'terminal_report',
      reasons: ['claude reported a session_id different from the controller-issued one: the candidate cannot be attributed to this run'],
    });
  }

  await writeFile(join(stateDir, 'candidate.json'), JSON.stringify(normalized.candidate, null, 2));

  // budgetExhausted 是报告体字段不进 candidate（candidate 恒 4 字段，见 normalizeTerminal）：
  // 控制器据它把「预算耗尽」路由到未达标可续分流，而不是把 reject 的形状红当成协议漂移。
  return finish({
    outcome: 'candidate',
    candidate: normalized.candidate,
    sessionId,
    budgetExhausted: normalized.budgetExhausted,
    // max-turns 硬停不会触发 Stop 事件；它不应被旧的 attemptNumber 口径误算成 hook 缺席。
    // 控制器累计对账 hookRuns 时只计 hookExpected=true 的候选 attempt。
    hookExpected: !normalized.budgetExhausted,
  });
}

// claude 线只读观测通道（transcript readback）：不 spawn、不写盘、不把 transcript 字节放进
// 输出——只给计数、条目类型与哈希比对结论（隐私纪律：任务内容不回显）。任何内部失败都归
// {available:false}：观测不可用不等于 run 出事，兜底永远是 wall-clock deadline，不是这里。
// 它的结论也不进任何 controller 证据通道——这是给「干完了还是卡住了」的独立观测面，处置
// （kill / resume / 继续等）留给人工决策。
export async function runClaudeReadback({ stateDir }) {
  const pointerRead = await readControllerJsonNoFollow(join(stateDir, 'thread.json'));
  if (pointerRead.missing) {
    return { available: false, reasons: ['no readable thread.json in the state dir'] };
  }
  if (!pointerRead.ok) {
    return { available: false, reasons: ['thread.json exists but is invalid or unsafe to read'] };
  }
  const pointer = pointerRead.value;
  if (typeof pointer?.threadId === 'string') {
    return { available: false, reasons: ['this state dir belongs to a codex run: readback here is claude-only'] };
  }
  if (!isClaudePointer(pointer)) {
    return {
      available: false,
      reasons: ['thread.json predates the pointer shape with transcriptPath: launch under the current adapter to enable readback'],
    };
  }
  let st;
  try {
    st = await lstat(pointer.transcriptPath);
  } catch {
    return {
      available: false,
      reasons: ['transcript not found at the recorded path: the session may not have started yet, or the CLI transcript layout drifted'],
    };
  }
  let text;
  try {
    text = await readFile(pointer.transcriptPath, 'utf8');
  } catch {
    return { available: false, reasons: ['transcript is not readable by the controller'] };
  }
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  let lastEntryType = null;
  let firstUserSha256 = null;
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry?.type === 'string') {
      lastEntryType = new Set([
        'assistant', 'user', 'system', 'result', 'queue-operation', 'progress', 'summary',
      ]).has(entry.type) ? entry.type : 'unknown';
    }
    if (firstUserSha256 === null && entry?.type === 'user') {
      const content = entry?.message?.content;
      const textPart = typeof content === 'string' ? content
        : (Array.isArray(content) && content[0]?.type === 'text' ? content[0].text : null);
      if (typeof textPart === 'string') {
        firstUserSha256 = createHash('sha256').update(textPart, 'utf8').digest('hex');
      }
    }
  }
  // 归因是报告信号不是闸：mismatch 说明「transcript 首条 user 输入不是控制器发出的 prompt」，
  // 值得人工核查，但 readback 无权据此终止任何东西。
  const promptAttribution = typeof pointer.promptSha256 !== 'string' || firstUserSha256 === null
    ? 'unavailable'
    : (firstUserSha256 === pointer.promptSha256 ? 'match' : 'mismatch');
  return {
    available: true,
    mtimeMs: st.mtimeMs,
    lineCount: lines.length,
    lastEntryType,
    promptAttribution,
  };
}

async function defaultCodexCollect() {
  const { stdout } = await execFile('codex', ['--version']);
  return stdout;
}

// collect 与 prepareClaude 的同名参数同构：测试注入 stub，不真调 codex 二进制。
export async function prepareCodexProbesOnly({ stateDir, collect = defaultCodexCollect }) {
  await initStateDir(stateDir);
  const realStateDir = realpathSync(stateDir);
  let codexVersionRaw = null;
  try {
    codexVersionRaw = await collect();
  } catch (error) {
    // 探测失败照样落盘，但落的是一句自证的失败文本——assertLaunchable 从中解析不出版本号形态
    // 就会红，「codex 根本没装」因此过不了前置闸（F-2 附带）。
    codexVersionRaw = `probe failed: ${error.message}`;
  }
  const probes = { codexVersionRaw };
  await writeFile(join(realStateDir, 'probes.json'), JSON.stringify(probes, null, 2));
  return { stateDir: realStateDir, probes };
}

export const POLL_INTERVAL_MS = 5000;
export const WALL_CLOCK_DEADLINE_MS = 1_800_000;
// 跑飞护栏（P-2）。与上面的 WALL_CLOCK_DEADLINE_MS、与 MAX_AUTO_RESUMES 同类：**adapter 侧的
// 安全常量，不是 contract 预算**。它们不写进 contract、不由用户提供、不受「budget 只在用户明给
// 时才设」那条协议规则约束——那条规则管的是 tokenBudget 这类会改变执行体行为的参数，这两条只
// 决定控制器什么时候停止等待。
//
// 起因是第二次 codex 真实冒烟：执行面坏掉（工具调用全部失败）之后，服务端的自动链式续轮把一个
// 必然失败的 turn 重复了 9 次、烧掉 57,952 tokens、target root 分毫未动，而且不会自己停——唯一
// 的兜底是 30 分钟 wall clock，对「每 15 秒烧 35k tokens」这种形态几乎不构成保护，跑满会是
// 100+ turn、数百万 tokens。是人手工 SIGTERM 才停的，无人值守场景下就是一个敞开的成本敞口。
//
// 信号只取控制器已经拿到的两样：轮询回来的 goal envelope 里的 tokensUsed，以及已订阅的
// turn/started·turn/completed 计数。**不解析执行体输出**——那会撕开信任模型（执行体产出的内容
// 不得成为控制器判据）；护栏属资源层，不属证据通道。也刻意**不做**「连续 N 轮无文件变更即熔断」：
// 合法任务可能连着几轮只读不写，误杀真活的代价比多烧一点 token 更高。
//
// 取值依据（不是拍脑袋，是按 2026-08-09 那次冒烟的实测节奏推算的）：9 个 turn / 195 秒 /
// 57,952 tokens，即约 6,439 tokens 每 turn、约 297 tokens 每秒。据此——
//   - 30 turn  → 约 193k tokens、约 11 分钟触顶；
//   - 200k tokens → 约 31 turn、约 11 分钟触顶。
// 两条因此在这个形态下**大致同时**触顶，谁都不是死重。而对「轮次少、单轮上下文巨大」的另一种
// 形态，token 那条自然先触顶，各司其职。200k 对一个零产出的跑飞 run 来说仍然给得很宽。
// 曾取 500k，被这套推算否掉：那要约 28 分钟才触顶，只比 30 分钟的 wall clock 早两分钟，等于死重。
export const MAX_TURNS_PER_ATTEMPT = 30;
export const MAX_TOKENS_PER_ATTEMPT = 200_000;
// 判「上次 launch 是否还活着」的启发式：心跳每 poll 拍刷新一次（默认 5s 一拍）；30s 容忍几拍
// 失联抖动，超过就认定持有者进程死了（SIGKILL/断电，finally 没机会跑）。注意「持有者死了」
// **不等于**「它起的 app-server 也死了」：租约到期没有任何一侧会去 clear goal（终审 I2），
// 孤儿 daemon 是否随 stdio EOF 自退本轮未实测。因此过期租约同样拦住 relaunch，要先跑 close。
export const LEASE_TTL_MS = 30_000;

function sleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

// contract.budget.max_minutes 存在时与传入 deadlineMs（缺省 WALL_CLOCK_DEADLINE_MS）取 min——
// 用户显式给的墙钟预算永远不能被更宽的默认值盖过。
function effectiveDeadlineMs(contract, deadlineMs) {
  const base = deadlineMs ?? WALL_CLOCK_DEADLINE_MS;
  const budget = contract?.budget;
  const budgetMs = budget?.user_provided && typeof budget.max_minutes === 'number'
    ? budget.max_minutes * 60_000
    : undefined;
  return budgetMs === undefined ? base : Math.min(base, budgetMs);
}

// 护栏与 contract 预算取更紧的那侧，方向与 effectiveDeadlineMs 一致：用户明给的预算永远不能被
// 更宽的护栏盖过。反过来也成立且是刻意的——contract 只能把护栏调得**更紧**，抬不高它。护栏是
// adapter 常量，把它做成可由 contract 抬高的字段就等于让一份 contract 关掉自己的刹车。
function effectiveCap(base, contract, field) {
  const budget = contract?.budget;
  const limit = budget?.user_provided && typeof budget[field] === 'number' && budget[field] > 0
    ? budget[field]
    : undefined;
  return limit === undefined ? base : Math.min(base, limit);
}

// resume 专用的 token 上限（review M-1）。根因是一个口径错配：`budget.max_tokens` 在服务端是**整个
// run 的累计预算**（原样当 tokenBudget 交给 goal.set），护栏量的却是**本 attempt 的增量**，同一个
// 字段在同一条路径上两种含义。后果是操作员按 §4 用 `--raise-token-budget N` 明确抬完预算之后，
// 护栏仍按 contract 里那个旧值掐——而 reason 把他指向唯一帮不上忙的那根杆子（他刚拉过正确的那根），
// 本该读到的 budgetLimited 成因也被换成「先查执行面是否健康」；唯一出路是改 contract，而改 contract
// 换 hash 换 state 目录，thread 就丢了。
//
// `--raise-token-budget` 本身就是「用户明确确认要抬预算」的载体，所以给了就以它为准，取代 contract
// 里那个已被它抬过的旧值。adapter 常量仍是天花板：抬预算只在常量以内被认，抬不穿它——「谁都不能
// 关掉自己的刹车」不变。
function resumeTokenCap(contract, raiseTokenBudget) {
  return Number.isFinite(raiseTokenBudget) && raiseTokenBudget > 0
    ? Math.min(MAX_TOKENS_PER_ATTEMPT, raiseTokenBudget)
    : effectiveCap(MAX_TOKENS_PER_ATTEMPT, contract, 'max_tokens');
}

// 三态而不是「活/不活」：过期租约不是「没有残留」，而是「有残留且持有者已失联」——那一侧留下的
// app-server 与 goal 都可能还活着（租约 TTL 到期不触发任何 clear），此时直接 relaunch 会在同一
// target root 上叠出第二个执行器。'stale' 因此也拦，出口是先跑 close 清残留（终审 I2）。
// 读不出文件 = 'none'；读得出但字节损坏 = 'stale'（不认成 none，坏字节不构成「没有残留」的证据）。
async function leaseResidue(stateDir) {
  let text;
  try {
    text = await readFile(join(stateDir, 'lease.json'), 'utf8');
  } catch {
    return 'none';
  }
  let lease;
  try {
    lease = JSON.parse(text);
  } catch {
    return 'stale';
  }
  const heartbeatAt = typeof lease?.heartbeatAt === 'number' ? lease.heartbeatAt : 0;
  return (Date.now() - heartbeatAt) < LEASE_TTL_MS ? 'live' : 'stale';
}

// lease.json 是互斥原语：assertLaunchable 的 leaseResidue 闸读的就是它。别的进程的活租约在场
// 时，本次运行既不覆写也不删除——覆写和无条件删除是同一个后果（原语一没，闸失效，第三个进程
// 就能并发起 launch）。这里只做"不抢占"，不做"拒绝运行"：finalize/close 该不该在活 launch
// 底下被拦，是证据通道的政策问题（T11 review 疑虑② 裁定不加闸），清理层不替它做主。
function leaseHeldByAnother(leasePath) {
  if (!existsSync(leasePath)) return false;
  let lease;
  try {
    lease = JSON.parse(readFileSync(leasePath, 'utf8'));
  } catch {
    return true;   // 读不懂就当别人的：宁可不碰，也不销毁一份可能有效的原语
  }
  const heartbeatAt = typeof lease?.heartbeatAt === 'number' ? lease.heartbeatAt : 0;
  return lease?.pid !== process.pid && (Date.now() - heartbeatAt) < LEASE_TTL_MS;
}

// cleanup 只删自己写的那一份租约（T11 review Minor 1 实测：finalize/close 在一次活 launch 底下
// 删掉了对方的租约）。认领凭据就是 refreshLease 写进去的 {pid, startedAt}；对不上就留在原地并
// 给出 reason。纯清理层：reason 只走 stderr，不进任何证据通道。
export function releaseOwnLease({ leasePath, pid, startedAt }) {
  if (!existsSync(leasePath)) return { released: false };
  let lease;
  try {
    lease = JSON.parse(readFileSync(leasePath, 'utf8'));
  } catch {
    return { released: false, reason: `${leasePath} is unreadable or malformed; left in place` };
  }
  if (lease?.pid !== pid || lease?.startedAt !== startedAt) {
    return {
      released: false,
      reason: `${leasePath} belongs to another run (pid=${lease?.pid}, startedAt=${lease?.startedAt}); left in place`,
    };
  }
  rmSync(leasePath, { force: true });
  return { released: true };
}

// 租约持有者是否还活着。返回一句可以直接进 reason 的判据说明，活着才返回非空。
//
// 两条判据缺一不可（review M-3）：
// ① 心跳在 TTL 内；② 持有者 pid 仍在。
// 只看心跳是错的，而且是本轮 N-2 修复引入的 fail-open：心跳只在轮询每拍与连接阶段各刷一次，
// 两次刷新之间最长可达 pollInterval + RPC_TIMEOUT_MS(60s)，**远超** LEASE_TTL_MS(30s)。一个正
// 活着、只是卡在一次慢 rpc 上的 run，其租约会被并发的 close 判成残留删掉——实测持有者 pid 当时
// 还活着，而 close 的 reason 却说 "left behind by an earlier run"，既不实也把互斥原语弄没了。
// 反过来「pid 还在就保留」在 pid 被回收时只会**多保留**一份本该删的租约，方向 fail-closed，
// 操作员仍可换 --controller 名脱身。
function leaseHolderAlive(lease) {
  if (lease === null || typeof lease !== 'object') return null;
  const heartbeatAt = typeof lease.heartbeatAt === 'number' ? lease.heartbeatAt : 0;
  const age = Date.now() - heartbeatAt;
  if (age < LEASE_TTL_MS) return `heartbeat is ${age}ms old, still within the ${LEASE_TTL_MS}ms TTL`;
  const { pid } = lease;
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    // signal 0 只做存在性/权限探测，不投递任何信号。
    process.kill(pid, 0);
    return `heartbeat is ${age}ms stale but the holder process is still running`;
  } catch (error) {
    // ESRCH=进程不在了。EPERM=进程在、但属于别的用户——按「还活着」处理（fail-closed）。
    return error?.code === 'EPERM'
      ? `heartbeat is ${age}ms stale but the holder process exists under another user`
      : null;
  }
}

// close 专用的租约释放：清掉会把这个 state 目录锁死的残留租约（N-2）。
// 与 releaseOwnLease 的分工：那条是**清理层**的自我收尾，只认自己写的那一份；这条是 close 的
// **收尾语义**本身——残留租约按定义是别人（或已死的自己）留下的，只认自己就等于永远清不掉。
// 唯一不删的形态是**持有者还活着**的租约：删掉它就是销毁互斥原语本身，第三个进程随即能并发
// 起 launch（T11 review Minor 1 的同一后果）。
// 坏字节按残留处理：它没有心跳也没有 pid 可读，而 launch 侧的 leaseResidue 把它判成 'stale' 并
// 拦住——close 不清它就没有任何一条路径清得掉。
export function releaseResidualLease({ leasePath }) {
  if (!existsSync(leasePath)) {
    return { present: false, released: false, runtimeQuiesced: true, reasons: [] };
  }
  let lease = null;
  try {
    lease = JSON.parse(readFileSync(leasePath, 'utf8'));
  } catch {
    lease = null;
  }
  const alive = leaseHolderAlive(lease);
  if (alive) {
    return {
      present: true,
      released: false,
      runtimeQuiesced: false,
      reasons: [`lease.json belongs to a run that is still alive (pid=${lease?.pid}, ${alive}): left in place, `
        + 'nothing was released. Confirm that run is really gone (or start fresh under a different '
        + '--controller name) before relaunching'],
    };
  }
  rmSync(leasePath, { force: true });
  return {
    present: true,
    released: true,
    runtimeQuiesced: true,
    reasons: [`released a residual lease.json (pid=${lease?.pid ?? 'unreadable'}) left behind by a run that is no longer running`],
  };
}

function defaultCodexClientFactory({
  codexHome, cwd, onEnvelope, onChildFailure,
}) {
  return new GoalRpcClient({
    codexHome, cwd, onEnvelope, onChildFailure,
  });
}

const DEFAULT_AUTH_SOURCE = join(homedir(), '.codex', 'auth.json');
// mkdtempSync 前缀，close 的整目录删除只认这个前缀（见 runCodexClose）。
const CODEX_HOME_PREFIX = 'gc-codex-home-';

// goal-set 单调序列号的唯一账本（verifyFinalizeAttribution 的三重归因第三项）。解析失败即
// 向上抛：静默跳过坏行会让序列号看着连续、实际有洞，归因就成了假证据。
async function readLedger(stateDir) {
  let text;
  try {
    text = await readFile(join(stateDir, 'goal-set-ledger.jsonl'), 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line));
}

function appendLedgerEntry(stateDir, entry) {
  return appendFile(join(stateDir, 'goal-set-ledger.jsonl'), `${JSON.stringify(entry)}\n`);
}

// turn-counts.json 的语义必须写在文件里（P-4）。第二次冒烟实测：pass2 只跑一个 turn 且成功，
// 文件却是 {"started":1,"completed":0}；被中止的 pass1 是 {"started":9,"completed":8}。两处「差一」
// 同源，而且是竞态不是漏写——收到的 turn 通知一条不落全部同步落盘（见下面的通知回调），差的那条
// 根本没到过：goal 的 complete 是模型在 turn 内自标的，控制器轮询看得见它**严格早于**那个 turn
// 结束，拿到判定就收口，turn/completed 因此永远等不到。成功路径上 completed = started - 1 是必然。
//
// 所以修法不是补一个从未观察到的 completed（那是拿观测说谎），而是让文件自己说清计数的口径。
// 它是操作员判断「跑了几轮」的唯一依据，字面上的「差一」不解释就会被读成「最后一轮没跑完」。
const TURN_COUNTS_SEMANTICS = 'started/completed are counts of turn/started and turn/completed '
  + 'notifications observed by the controller, cumulative across attempts. The controller stops '
  + 'observing the moment it reaches a verdict, so a turn still in flight at that moment is counted '
  + 'in started only: completed = started - 1 is the normal shape of any run that ended mid-turn, '
  + 'including every successful one, because the goal reaches complete inside a turn and strictly '
  + 'before that turn ends. Read started as the number of turns that ran; '
  + 'do not read a missing completed as a turn that failed to finish. '
  // R-5：服务端对同一个 turn 的说法更强，翻 thread 历史的操作员会撞见它。两份证据都对，
  // 但必须放在一起读，否则「turn-counts 说它 started 过、服务端说它 interrupted」看着像矛盾。
  + 'The server records that same in-flight turn as "interrupted" in the thread history (the '
  + 'controller stops the app-server once the goal reaches its verdict, so the turn never gets to '
  + 'finish server-side either). Both records are accurate and describe the same normal ending.';

function writeTurnCounts(path, counts) {
  writeFileSync(path, JSON.stringify({ ...counts, semantics: TURN_COUNTS_SEMANTICS }));
}

// turn 计数是跨 attempt 累计量：resume 从磁盘现值续加，不清零——清零会让"launch 4 轮 + resume 1 轮"
// 的文件读起来只有 1 轮。
//
// 损坏时退回 0 起算而不是 fail-closed。理由**不再是**「这个数只供呈现」——P-2 之后 started 是 turn
// 护栏的直接输入（review L-1）。真正的理由是护栏只用**增量**：基线与计数器出自同一次读盘，文件损坏
// 时两边同为 0，`started - turnsBaseline` 因此照样等于本 attempt 真实跑过的轮次，护栏一点不受影响。
// 损坏丢掉的只有跨 attempt 的累计显示值，那一格确实只供呈现。
// 只取两个计数字段，semantics 这类说明字段读回来即丢弃：它是写给人的，不是记账的一部分。
function readTurnCounts(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return {
      started: Number.isInteger(parsed?.started) ? parsed.started : 0,
      completed: Number.isInteger(parsed?.completed) ? parsed.completed : 0,
    };
  } catch {
    return { started: 0, completed: 0 };
  }
}

// 连接阶段（auth-copy、租约、构造 client、start、initialize）的失败标记。
// 它与 body 内的失败必须在归因上分开：到这一步为止执行器一次都没被构造/启动过，工作目录没有
// 被碰过；混成同一条 reason 就是在如实性上说谎（F-2 实测三种形态全被报成「可能已改仓」）。
class CodexConnectError extends Error {
  constructor(cause) {
    super(cause?.message ?? String(cause));
    this.cause = cause;
  }
}

// launch/resume/finalize/close 共用的 auth-copy + lease + client 生命周期骨架（§5 安全模式）。
// 铁律（T10 review Important #1）：cleanup 定义与 SIGTERM/SIGINT 注册必须在 auth 副本可能落盘
// 之前就位，try 块起点在此、复制之前——mkdtempSync 之后的任何一步（复制 auth、chmod、
// 写 lease、构造 client）都可能抛错，保护窗口必须已经覆盖到。client 用 let 声明、
// cleanup 里用可选链调用，早期失败（client 尚未构造）时安全跳过 stop()。cleanup 幂等，只删
// auth 副本 + stop client + 释放**自己认领的** lease（见 releaseOwnLease），**不删 codexHome**
// （thread/goal 状态要跨 attempt 存活；
// 整目录清理只在 runCodexClose）。codexHome 由调用方给定：launch 现建，其余读 codex-home.path。
// 本函数**不写** codex-home.path：那个指针是「哪个 codexHome 持有活体 thread」的真值源，只有
// launch 在 thread/start 成功之后才有资格改它（与 thread.json 同一时刻落盘，两者必须自洽）。
async function withCodexClient({
  stateDir, codexHome, cwd, authSource, clientFactory,
}, body) {
  const authDest = join(codexHome, 'auth.json');
  const leasePath = join(stateDir, 'lease.json');
  const leaseStartedAt = Date.now();

  let client;
  let refreshLease;
  // 值得留痕的通知（N-5）：连接阶段就得存在——它在 client 构造之前由通知回调闭包捕获，
  // 又要在 body 返回后交给终局报告，两头都在内层 try 的作用域之外。
  const notices = [];
  // turn 计数同理，多一个理由：轮询循环的跑飞护栏（P-2）要在 body 里读它。baseline 是进入本次
  // attempt 时的磁盘现值——文件是跨 attempt 累计量，护栏据此把它换算成本 attempt 的增量。
  let turnCounts = { started: 0, completed: 0 };
  let turnsBaseline = 0;
  // 每个动作各自兜住异常。幂等此前就成立，**互不影响**却不成立：三句串在一起，第一句抛错
  // （例如隔离 codexHome 被 chmod 成不可写）后两句连跑都没跑；在 onFatal 里它还会把 stderr 写与
  // process.exit 一起带走，原始错误被 fs 栈盖掉（review m-1 实测 exit 7、凭证与租约双双留盘）。
  const attempt = (label, action) => {
    try {
      const settled = action();
      // stop() 是 async：它的 rejection 逃出 try/catch 就会变成 unhandledRejection，把 onFatal 引爆。
      if (typeof settled?.catch === 'function') settled.catch(() => {});
    } catch (error) {
      try {
        writeSync(2, `cleanup step "${label}" failed: ${error?.message ?? error}\n`);
      } catch { /* stderr 不可写时也不能让清理的其余两步跟着停 */ }
    }
  };
  // cleanup 可重入，不是一次性——一次性正是 M3 的成因：SIGTERM 在 auth 落盘之前到达时它跑了个空，
  // 随后 auth 副本与租约照常落盘，而 finally 里的第二次调用被「已清理过」的标志挡掉，凭证副本与
  // 租约双双留在盘上。三个动作各自幂等（rmSync force、kill 已退出的子进程、releaseOwnLease 只删
  // 自己认领的那一份），重复执行没有代价，而漏执行有。
  const cleanup = () => {
    attempt('remove auth copy', () => rmSync(authDest, { force: true }));
    attempt('stop app-server', () => client?.stop?.());
    attempt('release lease', () => {
      const lease = releaseOwnLease({ leasePath, pid: process.pid, startedAt: leaseStartedAt });
      if (lease.reason) process.stderr.write(`${lease.reason}\n`);
    });
  };
  // 信号处理器必须**真正终止进程**（review M-2）：此前它只跑 cleanup 就返回，进程照常往下跑，
  // 轮询下一拍的 refreshLease 又把 cleanup 刚释放的租约写回盘上——操作员中止不掉一个 launch，
  // 互斥原语还被一个已被终止的 run 重新宣示，最后那记 SIGKILL 留下的正是 N-2 的输入。
  //
  // 终止手段是「摘掉自己的监听器再把同一个信号重新投递给自己」，不是 process.exit()：
  // 实测 process.exit() 在线程池被一次阻塞的 fs 读卡住时**根本不终止进程**（authSource 是 FIFO
  // 即可复现，正是 auth 复制那一步），而 OS 层的默认信号处置不受线程池状态影响。它还有两个
  // 附带好处：父进程看到的是「死于信号」而不是一个自造的退出码；实测 process.kill 不返回——
  // 进程在这一行内就死了，cleanup 之后不存在任何能再写盘的窗口，因此也不需要一个中止标志。
  const onSignal = (signal) => {
    try {
      cleanup();
    } finally {
      process.removeListener(signal, onSignal);
      process.kill(process.pid, signal);
    }
  };
  // 「finally 不执行 → 凭证副本留在盘上」这条铁律的**第三种失效形态**：前两种是外部信号
  // （SIGTERM/SIGINT，上面那两行堵的），第三种是自家代码里的未捕获异常 / 未处理 rejection——
  // N-1 实测就是它（spawn 的 ENOENT 从 'error' 事件异步抛出，落进事件循环，finally 一行没跑，
  // 生产 auth.json 的字节级副本留在隔离 CODEX_HOME 里）。N-1 的就地修复已经堵住那一个入口，
  // 但前两次修复（T10「保护窗口起点钉错」、N3「写入跟着 symlink 走」）都只堵了当时想到的那个
  // 入口，随后各被新形态穿一次。所以这里挂进程级兜底：任何逃出 try/finally 的路径都先跑同一个
  // 幂等 cleanup。注册时机与信号处理器同一行、在 auth 副本可能落盘之前。
  // 兜底跑完**不得**把崩溃伪装成正常退出（F-1 的覆辙）：原始错误照常进 stderr、退出码非零，
  // 与 Node 未捕获异常的默认收场一致。stderr 用 writeSync——process.exit 会截断走管道的异步写。
  const onFatal = (error) => {
    try {
      cleanup();
    } finally {
      // 原始错误与非零退出码不得被 cleanup 自身的失败带走（review m-1）。
      try {
        writeSync(2, `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      } catch { /* stderr 不可写也不能改变「非零退出」这一点 */ }
      process.exit(1);
    }
  };
  // 最后一道网：事件循环被走空时 Node 直接退出——没有异常、没有信号，上面四路一个都不响，
  // finally 也永远等不到那个 await 恢复（review M-1 实测：app-server 中途死掉、且此刻恰好没有
  // rpc 在飞时 exit 13、stdout 全空、凭证副本留盘）。根因已在 adapter 侧修掉（rpc 超时 timer
  // 不再 unref、子进程 'exit' 归一成 rejection），这一路是兜底：'exit' 处理器只能做同步动作，
  // 而 cleanup 正好全是同步的；它同时兜住任何 process.exit() 直调（含上面两个处理器自己那次，
  // 重复执行无代价）。
  const onProcessExit = () => { cleanup(); };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);
  process.on('uncaughtException', onFatal);
  process.on('unhandledRejection', onFatal);
  process.on('exit', onProcessExit);

  try {
    // 内层 try 精确圈出连接阶段：它抛出的一切都归一成 CodexConnectError，body 抛出的一切原样上浮。
    // 两者的归因天差地别——连接阶段失败时执行器一次都没跑过、工作目录没被碰过，body 内失败则
    // 可能已在 turn 里改过仓。调用方据此给出不同的 reason（F-2）。
    try {
      await writeFile(authDest, await readFile(authSource));
      await chmod(authDest, 0o600);

      refreshLease = leaseHeldByAnother(leasePath)
        ? async () => {}                      // 别人占着：本次运行全程不碰这个文件
        : () => writeFile(leasePath, JSON.stringify({
          pid: process.pid, startedAt: leaseStartedAt, heartbeatAt: Date.now(),
        }));
      await refreshLease();

      // 同步写：onEnvelope 由 client 在收发时机同步调用（不被 await），并发 append 到同一文件用异步
      // fs.promises 有交错风险，这里用 *Sync 消掉这条竞争。
      const envelopesPath = join(stateDir, 'rpc-envelopes.jsonl');
      const onEnvelope = (entry) => appendFileSync(envelopesPath, `${JSON.stringify(entry)}\n`);

      // 子进程层面的失败（起不来 / 起来之后死掉）没有 RPC 响应可挂，此前一个字都不留：
      // 'error' 被 start() 的常驻监听器无声吞掉、'exit' 根本没人听（review m-3）。走 N-5 已经修好
      // 的那条通道，让终局报告与 envelope 日志都说得出真正的成因。
      const onChildFailure = (error) => {
        const message = error?.message ?? String(error);
        notices.push(`codex app-server failure: ${message}`);
        appendFileSync(envelopesPath, `${JSON.stringify({ direction: 'child', event: 'failure', message })}\n`);
      };

      // SIGTERM/SIGINT 若在上面任何一个 await 处到达，onSignal 已经跑完 cleanup 并终止了进程，
      // 根本走不到这一行——「操作员已经要求中止，进程却又拉起一个子进程」（M3）由信号处理器
      // 自己的终态保证，不再需要一个中止标志（review M-2）。
      client = clientFactory({
        codexHome, cwd, onEnvelope, onChildFailure,
      });

      // turn/started·turn/completed 计数。**不再只是呈现**（review L-1）：P-2 之后 started 是 turn
      // 跑飞护栏的直接输入，护栏触顶会给出终局报告。六态判定仍然全靠 goalGet 的 goal.status——
      // 计数只决定「还等不等下去」，不决定 goal 处在哪个状态。
      const turnCountsPath = join(stateDir, 'turn-counts.json');
      turnCounts = readTurnCounts(turnCountsPath);
      turnsBaseline = turnCounts.started;
      // method 名取自 adapter 的实测常量，不在这里重抄字面量——两处真值源迟早会漂。
      const [TURN_STARTED, TURN_COMPLETED] = TURN_BOUNDARY_METHODS;
      client.onNotification?.((notification) => {
        const { method } = notification;
        if (method === TURN_STARTED || method === TURN_COMPLETED) {
          if (method === TURN_STARTED) turnCounts.started += 1;
          else turnCounts.completed += 1;
          writeTurnCounts(turnCountsPath, turnCounts);
        }
        // 通知此前只被这里数了两个 method 就丢掉，一个字不落盘（N-5）。收哪些、payload 怎么收敛
        // 全在 adapter 的 noteworthyNotification 里判；这一层只负责落盘与回传给终局报告。
        // 与 request/response 同文件、同 append 姿态（*Sync，onEnvelope 不被 await，异步 append
        // 会交错），方向标 'notification' 把三者分开。
        const note = noteworthyNotification(notification);
        if (!note.record) return;
        notices.push(`codex notification ${note.method}: ${note.payload}`);
        appendFileSync(envelopesPath, `${JSON.stringify({
          direction: 'notification', method: note.method, payload: note.payload,
        })}\n`);
      });

      await client.start();
      await client.initialize();
    } catch (error) {
      throw new CodexConnectError(error);
    }
    return await body({
      client, refreshLease, notices, turnCounts, turnsBaseline,
    });
  } finally {
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('uncaughtException', onFatal);
    process.removeListener('unhandledRejection', onFatal);
    process.removeListener('exit', onProcessExit);
    cleanup();
  }
}

// launch/resume 共用的异常归一。三条出口互不重叠：
// ① 占号失败重抛——ATTEMPT_LIMIT_EXCEEDED / ATTEMPT_SLOT_TAKEN 是进程级失败（exit 1），被这里
//    吞成 terminal_report 就降级成了 exit 3，fail-closed 的配额语义随之破掉；
// ② 连接阶段失败如实说明仓库未被触碰——client 要么没构造出来、要么没连上，声称「可能已改仓」
//    会把操作员推去做一次无谓的 snapshot verify（F-2）；
// ③ 已连上之后失败保留原措辞：执行器可能已在 turn 内改过仓，「中止」绝不能被读成「无改动」（§6）。
function codexAttemptFailure(error, threadId) {
  if (error instanceof CodexConnectError) {
    return {
      outcome: 'terminal_report',
      threadId,
      // 措辞里刻意不出现 "snapshot verify" 这个词组：编排器与操作员都会照着 reason 决定要不要
      // 跑核对，出现即等于在要求它，哪怕前面缀着「无需」。
      reasons: [`codex daemon connection failed before any turn started (${error.message}): `
        + '失败发生在连接阶段（凭证复制 / app-server 启动 / initialize），执行器一次都没被启动，'
        + '工作目录未被触碰，没有需要核对的 mutation'],
    };
  }
  return {
    outcome: 'terminal_report',
    threadId,
    reasons: [`codex daemon connection failed mid-flight (${error.message}): 执行器可能已改仓，须跑 snapshot verify 才能断言 mutation 状态`],
  };
}

// 护栏触发时的终局措辞。三件事缺一不可：说明这是护栏而不是 contract 预算（否则操作员会去改
// contract 的 budget，而那一侧只会把上限调得更紧）、把观测值原样带上（「turn 在涨、token 在涨、
// 产出为零」正是执行面坏掉的形态，操作员据此判断该查什么）、给出下一步。
function guardrailReason({ what, cap, lever, observedTurns, turnCounts, observedTokens, tokensUsed }) {
  return `controller runaway guardrail tripped: ${what} reached the cap of ${cap} before the goal `
    + 'reached a terminal state '
    + `(observed this attempt: ${observedTurns} turn(s) started, ${observedTokens} tokens; `
    + `turn-counts.json cumulative started=${turnCounts.started} completed=${turnCounts.completed}; `
    + `goal tokensUsed=${tokensUsed}): `
    + '这是 adapter 侧的跑飞护栏（MAX_TURNS_PER_ATTEMPT / MAX_TOKENS_PER_ATTEMPT），不是 contract '
    + '预算，也不代表目标失败——触顶即终局报告，不产候选。next=先查执行面是否健康（工具调用是否'
    + `在连续失败、target root 是否分毫未动），执行面坏掉时这条护栏是唯一还在工作的刹车；${lever}`;
}

// 两条护栏各自的「这根杆子能不能拉」——分支必须分开说（review M-1）：contract 的 budget 一律只能
// 把护栏调得更紧（取 min），而 token 那条另有一根**能**拉的杆子（`--raise-token-budget`，用户确认
// 的载体，在 adapter 常量以内被认）。合成一句话就会在其中一支上把操作员推向帮不上忙的那根。
const TURN_LEVER = 'contract 的 budget 只能把护栏调得更紧（取 min）；这条轮次上限是 adapter 常量，'
  + 'contract 与 CLI 都抬不高它';
const TOKEN_LEVER = 'contract 的 budget 只能把护栏调得更紧（取 min）；确需更多预算时，resume 的 '
  + '--raise-token-budget N 是用户确认的载体，护栏会认它，但不超过 adapter 常量 MAX_TOKENS_PER_ATTEMPT';

// launch/resume 共用的轮询循环：每 pollIntervalMs 一拍 goalGet + 刷新租约，normalizeTerminal 分派
// 四态；超 deadline 即 fail-closed 终局。turn/token 两条跑飞护栏在「本拍判定不终局」之后才评估——
// 目标已经达成时不该被护栏改判：活干完了就是干完了，与它烧了多少无关。
//
// 两条护栏都按**本次 attempt** 计（与 deadline 同口径，deadline 也是每次 attempt 重新起算）：
// turn 数扣掉进入本 attempt 时的磁盘现值（turn-counts.json 是跨 attempt 累计量），token 数扣掉本
// attempt 第一拍观测到的 tokensUsed（goal 的 tokensUsed 同样跨 attempt 累计，resume 一进来就是个
// 大数——不扣基线会让一次合法续跑在第一拍就被误杀）。
async function pollGoalUntilTerminal({
  client, threadId, stateDir, attemptNumber, binding, refreshLease, deadline, pollIntervalMs, notices = [],
  turnCounts = { started: 0, completed: 0 }, turnsBaseline = 0,
  turnCap = MAX_TURNS_PER_ATTEMPT, tokenCap = MAX_TOKENS_PER_ATTEMPT,
}) {
  // 终局状态词自己不解释自己：`usageLimited` 是服务端给的字符串，成因（credits 余额 0、重置时间）
  // 只在 `account/rateLimits/updated` 通知里，而 close 会把唯一存着它的 codexHome 连 rollout 日志
  // 一起删掉（N-5）。终局报告是操作员唯一会读的东西，所以把收下来的通知并进 reasons。
  // 候选路径不并——那条不是失败，没有成因要解释。
  // notices 里存的是成形的整句（通知一类、子进程失败一类），这里只负责并进去。
  const withNotices = (reasons) => [...reasons, ...notices];
  const startedAt = Date.now();
  let tokensBaseline = null;
  while (true) {
    const elapsed = Date.now() - startedAt;
    if (elapsed >= deadline) {
      return {
        outcome: 'terminal_report',
        threadId,
        reasons: withNotices([`wall clock deadline of ${deadline}ms exceeded before the goal reached a terminal state`]),
      };
    }
    await sleep(Math.min(pollIntervalMs, deadline - elapsed));
    await refreshLease();
    const getEnvelope = await client.goalGet({ threadId });
    const normalized = normalizeCodexTerminal(getEnvelope?.result?.goal);
    if (normalized.kind === 'poll') {
      // tokensUsed 的类型不由 validateGoalEnvelope 保证（它只查键在不在），非数就当这一拍没有可用
      // 的 token 观测：护栏宁可少响一拍，也不拿一个 NaN 去比大小把 active 判成终局。
      const rawTokens = getEnvelope?.result?.goal?.tokensUsed;
      const tokensUsed = Number.isFinite(rawTokens) ? rawTokens : null;
      if (tokensUsed !== null && tokensBaseline === null) tokensBaseline = tokensUsed;
      const observedTokens = tokensUsed === null ? 0 : tokensUsed - tokensBaseline;
      const observedTurns = turnCounts.started - turnsBaseline;
      const tripped = observedTurns >= turnCap
        ? { what: 'turns started this attempt', cap: turnCap, lever: TURN_LEVER }
        : (observedTokens >= tokenCap
          ? { what: 'tokens used this attempt', cap: tokenCap, lever: TOKEN_LEVER } : null);
      if (tripped === null) continue;
      return {
        outcome: 'terminal_report',
        threadId,
        reasons: withNotices([guardrailReason({
          ...tripped, observedTurns, turnCounts, observedTokens, tokensUsed,
        })]),
      };
    }
    if (normalized.kind === 'candidate') {
      await writeCodexCandidate({
        stateDir, attemptNumber, candidate: normalized.candidate, binding, threadId,
      });
      return { outcome: 'candidate', threadId, candidate: normalized.candidate };
    }
    if (normalized.kind === 'terminal_report') {
      return {
        outcome: 'terminal_report', threadId, status: normalized.status, reasons: withNotices(normalized.reasons),
      };
    }
    return { outcome: 'terminal_report', threadId, reasons: withNotices(normalized.reasons) };   // kind === 'reject'
  }
}

// launch/resume 共用的 codex 侧前置判定：probes.json 存的是 prepare 时刻的观测，这里补上现场
// 重算的 contractHash、binding 交叉项与残留租约再交纯函数 assertLaunchable 下结论。
async function codexLaunchVerdict({
  contract, stateDir, binding, sandboxMode = CODEX_SANDBOX_MODE,
}) {
  const storedProbes = JSON.parse(await readFile(join(stateDir, 'probes.json'), 'utf8'));
  return assertCodexLaunchable(contract, {
    contractHash: contractHash(contract),
    confirmedHash: binding?.contractHash,
    baselineDigestStored: typeof binding?.baselineDigest === 'string' && HEX64.test(binding.baselineDigest),
    codexVersionRaw: storedProbes.codexVersionRaw,
    sandboxMode,
    expectedSandboxMode: sandboxMode,
    // 位置判定要比路径，两侧都先归一（contract 与 --state 各可能拿 symlink 的一边）。
    stateDir: canonicalPath(stateDir),
    targetRoots: (contract?.target_roots ?? []).map(canonicalPath),
    // 本次运行实际生效的 $TMPDIR（os.tmpdir() 读的就是它）。判定要它是因为标准位置那条正则
    // 认不出一个被改过的 TMPDIR，而沙箱的 excludeTmpdirEnvVar 说的正是「那个环境变量指的地方」。
    temporaryRoot: canonicalPath(tmpdir()),
    leaseResidue: await leaseResidue(stateDir),
  });
}

// candidate 的落盘：一份按 attempt 归档的**控制器信封**、一份是「最近一次候选」的老位置。
//
// 起因（R-2）：codex 的候选终态是一个 exact 形状（`{status:"ready_for_postflight",remaining_work:false}`，
// workflow.mjs 的闭世界契约），两个 attempt 产出的是**同一串字节**——「手里这份 candidate 出自哪一
// 轮」在协议层根本不可判，而那个形状不能改（改它是协议变更，有跨版本影响）。所以身份只能由控制器
// 侧绑定。
//
// 归档的**不是**裸 candidate 而是一个信封：协议对象是喂给 `nextAction` 的那个 `runtimeResult`，
// 归档文件是控制器自己的产物，可以带控制器自己的事实。信封让 finalize 那道闸有东西可核——只看
// 「文件在不在」的话，一个零字节文件、或把上一轮那份改个名，都能骗过它。
// `candidate.json` 保留原位不动（既有的对外产物，仍是裸 candidate），但它只是「最近一次候选」，
// **不是**「本轮的候选」——续跑以终局报告收场时它仍是上一轮那份。
const CANDIDATE_ENVELOPE_FIELDS = Object.freeze(['attempt', 'binding', 'candidate', 'threadId']);

async function writeCodexCandidate({
  stateDir, attemptNumber, candidate, binding, threadId,
}) {
  await writeFile(join(stateDir, 'attempts', `${attemptNumber}-candidate.json`), `${JSON.stringify({
    attempt: attemptNumber, binding: binding ?? null, candidate, threadId: threadId ?? null,
  }, null, 2)}\n`);
  await writeFile(join(stateDir, 'candidate.json'), JSON.stringify(candidate, null, 2));
}

// finalize 的前置：最近一次 attempt 必须自己产出过候选。
//
// 危险形态是 R-2 与 N-6 合流之后的那个：续跑因护栏触顶或 `budgetLimited` 返回终局报告（按文档
// 「触顶即终局报告，不产候选」），可编排器手里还攥着首发那份 candidate；只要此刻 postflight 恰好
// 转绿（执行体在被掐断之前把活干完了是完全可能的），这条链就能一路推到 finalize——而 finalize 自己
// set complete 再读回，`runtimeReadback` 也照不出「执行体是被中断的」。实测确认：把 attempt 1 的
// candidate 配 attempt 2 的绿 postflight 喂进状态机，四步与用 attempt 2 的完全一样，同样走到 complete。
// 控制器侧能判的事实只有这一条，判它就够堵住这条 fail-open。
//
// 核的是信封的内容，不是「文件在不在」：文件名可预测，只判存在的话一个零字节文件就能放行。
// 四项——信封形状闭世界、attempt 号与文件名自洽（防把上一轮那份改名顶上）、candidate 本身仍是
// 合法终态（判据取自 workflow.mjs 那个闭世界契约，不在这里抄第二遍）、binding 三元组与本次
// finalize 的 binding 逐字相同（跨 run 的候选顶不进来）。
// 前提仍是「state 目录在执行体可写面之外」——那条由 launch 前置闸把关（见 codex.mjs 的
// stateDirReasons）；采集层传入的 targetRoots 不是一组路径字符串时（非数组、空集、含非字符串
// 元素），那道位置闸同样 fail-closed。本闸不声称能识别一个能写 state 目录的对手伪造的信封。
async function assertLatestAttemptProducedCandidate(stateDir, binding) {
  const attempt = await maxExistingAttempt(stateDir);
  if (attempt === 0) {
    return { ok: false, reasons: ['no attempt has been claimed in this state dir: there is nothing to finalize'] };
  }
  const stale = `attempt ${attempt} produced no usable candidate: the most recent runtime action on this `
    + 'state dir did not leave one, so any candidate still in hand belongs to an earlier attempt and must '
    + 'not be finalized (next=re-run `resume` until the latest attempt itself yields a candidate, or report '
    + 'the terminal outcome and stop)';
  let envelope;
  try {
    envelope = JSON.parse(await readFile(join(stateDir, 'attempts', `${attempt}-candidate.json`), 'utf8'));
  } catch {
    return { ok: false, reasons: [stale] };
  }
  const shaped = envelope !== null && typeof envelope === 'object' && !Array.isArray(envelope)
    && CANDIDATE_ENVELOPE_FIELDS.length === Object.keys(envelope).length
    && CANDIDATE_ENVELOPE_FIELDS.every((field) => Object.hasOwn(envelope, field));
  if (!shaped || envelope.attempt !== attempt) {
    return { ok: false, reasons: [`${stale}; the archived candidate for that attempt is not a well-formed controller envelope`] };
  }
  const terminal = runtimeTerminalState('codex', envelope.candidate);
  if (!terminal.ok) {
    return { ok: false, reasons: [`${stale}; the archived candidate is not a valid codex terminal state`, ...terminal.reasons] };
  }
  const bound = envelope.binding !== null && typeof envelope.binding === 'object'
    && ['contractHash', 'baselineDigest', 'runId'].every((field) => envelope.binding[field] === binding?.[field]);
  if (!bound) {
    return { ok: false, reasons: [`${stale}; the archived candidate is bound to a different run than this finalize`] };
  }
  return { ok: true, reasons: [] };
}

// 从 `thread/resume` 响应里采出与物理面有关的三项 + thread 身份，判定交纯函数 assertResumedSession。
// 路径在这一层过 canonicalPath：判定是纯函数、碰不了 fs，归一只能在采集层做。
// 取不到的字段原样留 undefined 交给判定——这层不做任何「缺了就当没事」的兜底，缺失本身就是红。
function observeResumedSession(envelope) {
  const result = envelope?.result;
  const roots = result?.runtimeWorkspaceRoots;
  return {
    threadId: result?.thread?.id,
    // 沙箱块整块交出去（判定要逐字比对，见 sandboxDrift）。这里不摘字段——摘一个字段正是
    // 「同 type 而可写面被放大的沙箱照样过闸」那条缺口的成因。
    sandbox: result?.sandbox,
    cwd: canonicalPath(result?.cwd),
    workspaceRoots: Array.isArray(roots) ? roots.map(canonicalPath) : roots,
  };
}

// resume/finalize/close 复用上一次 launch 留下的会话坐标：threadId 与 codexHome 都是 launch 落盘的
// 事实，读不回来就没有可续跑/可收口的活体 thread（fail-closed，不新建）。
async function readCodexSession(stateDir) {
  let threadId;
  let cwd;
  let codexHome;
  try {
    ({ threadId, cwd } = JSON.parse(await readFile(join(stateDir, 'thread.json'), 'utf8')));
  } catch {
    return { ok: false, reasons: ['no thread.json in the state dir: there is no prior codex thread to reconnect to'] };
  }
  try {
    codexHome = (await readFile(join(stateDir, 'codex-home.path'), 'utf8')).trim();
  } catch {
    return { ok: false, reasons: ['no codex-home.path in the state dir: the isolated CODEX_HOME from launch is gone'] };
  }
  if (typeof threadId !== 'string' || threadId.length === 0) {
    return { ok: false, reasons: ['thread.json holds no usable threadId'] };
  }
  if (codexHome.length === 0) {
    return { ok: false, reasons: ['codex-home.path is empty'] };
  }
  return {
    ok: true, threadId, cwd, codexHome, reasons: [],
  };
}

// 八步（task-10 brief）：binding 三方交叉（同 T9 fail-closed 姿态）→ codex 侧 assertLaunchable
// 前置（残留租约/沙箱声明/版本采集，红即不起 client）→ 配额天花板只读预检 → auth-copy（独立
// mkdtemp、只读复制、chmod 0600，绝不碰 sqlite/config）→ start/initialize → nextAttempt 占号
// （连上了才算起飞）→ threadStart → threadId 落盘 →
// goalSet（ledger 先落再判 status）→ assertSetReturnedStatus 不过即终局（不发 turnStart）→
// turnStart 起首轮 → 轮询（每拍 goalGet + 刷新租约，通知只记 turn 边界计数）→ normalizeTerminal
// 分派 → deadline / daemon 中途死均 fail-closed 终局（后者报告体显式要求 snapshot verify）。
export async function runCodexLaunch({
  contract, stateDir, prompt, turnText, binding, clientFactory = defaultCodexClientFactory,
  authSource = DEFAULT_AUTH_SOURCE, deadlineMs, pollIntervalMs = POLL_INTERVAL_MS,
  sandboxMode = CODEX_SANDBOX_MODE,
}) {
  // binding（主会话持有的 runBinding）缺失、损坏、或对不上 stateDir 末段一律 fail-closed，不起 client。
  if (binding?.contractHash !== basename(stateDir)) {
    return {
      outcome: 'terminal_report',
      reasons: ['runBinding is missing, malformed, or does not match the state directory this attempt was prepared under'],
    };
  }

  const verdict = await codexLaunchVerdict({ contract, stateDir, binding, sandboxMode });
  if (!verdict.ok) {
    return { outcome: 'terminal_report', reasons: verdict.reasons };
  }

  // 配额耗尽是死局，零副作用处先判掉：不占号、不复制凭证、不起 daemon（真正的占号在下面的
  // 回调体里）。throw 而不是返回终局报告——它是进程级失败（exit 1），见 AttemptClaimError。
  await assertAttemptBudgetLeft(stateDir);

  // auth-copy（§5 安全模式）：codexHome 与任何 work 目录独立 mkdtemp，只读复制生产 auth、chmod 0600，
  // 绝不碰 goals sqlite/config；路径在 thread/start 成功后与 thread.json 一同落盘供 resume/finalize/close 复用。
  const codexHome = mkdtempSync(join(tmpdir(), CODEX_HOME_PREFIX));
  const cwd = contract.target_roots[0];

  let threadId;
  let initialTurnIds;
  try {
    return await withCodexClient({
      stateDir, codexHome, cwd, authSource, clientFactory,
    }, async ({
      client, refreshLease, notices, turnCounts, turnsBaseline,
    }) => {
      // 真占号的时刻：start/initialize 都过了，daemon 真的连上了才算起飞（F-2，与 claude 侧
      // 「下一行就是 spawn」同构）。auth.json 不存在、codex 二进制缺失、daemon 起不来这三种
      // 「什么都没发生」的失败全落在连接阶段，一格都不占——它们的原因都在 contract 之外，改正
      // 不换 contract hash 也就不换 state 目录，占在前面等于连撞三次就把这份 contract 锁死。
      const attemptNumber = await nextAttempt(stateDir);

      ({ threadId, initialTurnIds } = await client.threadStart({ sandbox: sandboxMode }));
      // cwd 一并落盘：finalize/close 不读 contract，重连 daemon 时要拿回同一个工作目录。
      // codex-home.path 与 thread.json 在同一时刻落盘：这一刻之前，state 目录里的两个指针都还
      // 指向上一次成功的那套；这一刻之后，两个都指向本次。中间不存在「thread 坐标说重连旧
      // thread、codexHome 指针说用这个空目录」的自相矛盾态。
      await writeFile(join(stateDir, 'codex-home.path'), codexHome);
      await writeFile(join(stateDir, 'thread.json'), JSON.stringify({ threadId, cwd }));

      const tokenBudgetParam = contract.budget?.user_provided && contract.budget.max_tokens
        ? { tokenBudget: contract.budget.max_tokens } : {};
      const setEnvelope = await client.goalSet({ threadId, objective: prompt, ...tokenBudgetParam });
      const sequence = (await readLedger(stateDir)).length + 1;
      await appendLedgerEntry(stateDir, {
        sequence,
        requestedStatus: 'active',
        updatedAt: setEnvelope?.result?.goal?.updatedAt ?? null,
        threadId,
      });
      const setVerdict = assertSetReturnedStatus(setEnvelope, 'active');
      if (!setVerdict.ok) {
        return {
          outcome: 'terminal_report', threadId, status: setVerdict.observed ?? undefined, reasons: setVerdict.reasons,
        };
      }

      const turnCorrelation = randomBytes(32).toString('hex');
      const turnInputText = bindControllerTurnText({
        text: turnText ?? prompt,
        correlation: turnCorrelation,
      });
      const turnInputSha256 = sha256Text(turnInputText);
      const turnEnvelope = await client.turnStart({ threadId, text: turnInputText });
      const turnId = turnEnvelope?.result?.turn?.id ?? null;
      const terminal = await pollGoalUntilTerminal({
        client,
        threadId,
        stateDir,
        attemptNumber,
        binding,
        refreshLease,
        deadline: effectiveDeadlineMs(contract, deadlineMs),
        pollIntervalMs,
        notices,
        turnCounts,
        turnsBaseline,
        turnCap: effectiveCap(MAX_TURNS_PER_ATTEMPT, contract, 'max_turns'),
        tokenCap: effectiveCap(MAX_TOKENS_PER_ATTEMPT, contract, 'max_tokens'),
      });
      return { ...terminal, turnId, initialTurnIds, turnInputSha256 };
    });
  } catch (error) {
    if (error instanceof AttemptClaimError) throw error;
    // 连接阶段失败的 codexHome 是本次 mkdtemp 出来、从未连上过的：没有 thread、没有 goal，
    // cleanup 已把唯一落过盘的东西（auth 副本）删掉，它按定义是空的。删掉它——
    // 「cleanup 不删 codexHome」那条铁律保护的是**连上过**的 codexHome（thread/goal 状态要跨
    // attempt 存活），从未连上的不在保护范围。
    //
    // 不删的代价是本轮占号挪位新造出来的：被拒的 launch 从此没有次数上限（上限正是本轮拿掉的），
    // 每撞一次就留一个无人回收的临时目录。连上之后才失败的那些仍然占号，因而仍受配额封顶。
    if (error instanceof CodexConnectError) rmSync(codexHome, { recursive: true, force: true });
    return codexAttemptFailure(error, threadId);
  }
}

// GoalSession v2 recovery/readback. It reuses the same isolated CODEX_HOME and client lifecycle as
// resume/finalize, but performs no goal mutation and starts no turn.
export async function runCodexReadback({
  stateDir, clientFactory = defaultCodexClientFactory, authSource = DEFAULT_AUTH_SOURCE,
}) {
  const session = await readCodexSession(stateDir);
  if (!session.ok) return { available: false, reasons: session.reasons };
  try {
    return await withCodexClient({
      stateDir,
      codexHome: session.codexHome,
      cwd: session.cwd,
      authSource,
      clientFactory,
    }, async ({ client }) => {
      const envelope = await client.threadRead({ threadId: session.threadId, includeTurns: true });
      const thread = envelope?.result?.thread;
      if (thread?.id !== session.threadId || !Array.isArray(thread.turns)) {
        return { available: false, reasons: ['thread/read returned no attributable turn history'] };
      }
      return {
        available: true,
        thread_id: thread.id,
        turns: thread.turns.map(summarizeNativeTurn),
      };
    });
  } catch (error) {
    return { available: false, reasons: [`native readback failed: ${error.message}`] };
  }
}

// 六步（task-11 brief）：binding 三方交叉 → codex 侧 assertLaunchable 前置 → 复用 launch 落盘的
// threadId/codexHome（读不回来即终局，不新建 thread）→ 配额天花板只读预检 → withCodexClient
// 连上 daemon 后 nextAttempt 占号 →
// thread/resume 重连，再按 resumeRpcOps 逐 op 执行（goal.set → inject_items → turn/start；
// set 后 ledger 续接 +1 并 assertSetReturnedStatus，不过即终局，后两个 op 一个都不发）→
// 与 launch 同一个轮询循环。
//
// raiseTokenBudget 只在调用方显式传入时才带上：预算仅用户明给，抬预算须经用户确认，CLI 的
// --raise-token-budget 就是那份确认的载体（缺省绝不自动抬，否则等于绕过 §4 的 budgetLimited 停机）。
export async function runCodexResume({
  contract, stateDir, diagnosticText, binding, raiseTokenBudget,
  clientFactory = defaultCodexClientFactory, authSource = DEFAULT_AUTH_SOURCE,
  deadlineMs, pollIntervalMs = POLL_INTERVAL_MS,
}) {
  // 按值判而不是按类型判：NaN / Infinity / -5 / 0 全是 typeof 'number'，一道纯类型闸放它们过去
  // 之后，resumeTokenCap 的 `Number.isFinite && > 0` 会把它们**静默**换回 contract 里那个旧上限，
  // 而 resumeRpcOps 同时把同一个值原样当 tokenBudget 送到服务端 goal.set。两处回落都不出声，
  // 正是这条守卫要消掉的形态（realrun review 发现 3b）。
  if (raiseTokenBudget !== undefined && !(Number.isFinite(raiseTokenBudget) && raiseTokenBudget > 0)) {
    throw new TypeError('raiseTokenBudget must be a positive finite number when provided');
  }
  if (binding?.contractHash !== basename(stateDir)) {
    return {
      outcome: 'terminal_report',
      reasons: ['runBinding is missing, malformed, or does not match the state directory this attempt was prepared under'],
    };
  }

  const verdict = await codexLaunchVerdict({ contract, stateDir, binding });
  if (!verdict.ok) {
    return { outcome: 'terminal_report', reasons: verdict.reasons };
  }

  const session = await readCodexSession(stateDir);
  if (!session.ok) {
    return { outcome: 'terminal_report', reasons: session.reasons };
  }
  const { threadId, codexHome } = session;

  // 配额耗尽先在零副作用处判掉（同 runCodexLaunch）；真占号在回调体里，连上 daemon 之后。
  await assertAttemptBudgetLeft(stateDir);

  try {
    return await withCodexClient({
      stateDir, codexHome, cwd: session.cwd ?? contract.target_roots[0], authSource, clientFactory,
    }, async ({
      client, refreshLease, notices, turnCounts, turnsBaseline,
    }) => {
      // 与 claude 侧同构（F-2）：daemon 真的连上了才占号，连接阶段的失败一格都不占。
      const attemptNumber = await nextAttempt(stateDir);

      // 重连既有 thread 用 thread/resume（不是新建的 thread/start）；参数形状 {threadId} 已由
      // T5 的 schema 核对坐实（required=['threadId']）。
      //
      // 返回体不得丢弃：它是**续跑路径上唯一的物理面观测**。launch 靠请求参数把 `--sandbox` 钉死，
      // resume 只传 threadId，沙箱由服务端从持久化 thread 状态恢复——不读回来核一遍，「本 adapter
      // 唯一可核的物理面」这句声明在续跑上就只是信任，不是观测。核不过即终局报告：此刻还没发
      // goal.set、没注入、没起 turn，执行体一步都没跑。
      const continuity = assertResumedSession({
        observed: observeResumedSession(await client.threadResume({ threadId })),
        threadId,
        targetRoots: contract.target_roots.map(canonicalPath),
      });
      if (!continuity.ok) {
        return { outcome: 'terminal_report', threadId, reasons: continuity.reasons };
      }

      // 逐 op 执行 resumeRpcOps 的返回：params 一律取自那个纯函数，不在这里二次拼装——
      // tokenBudget 带不带、inject 的 item 形状、turn/start 的收口句都只有一处真值源。
      for (const op of resumeRpcOps({ threadId, diagnosticText, tokenBudget: raiseTokenBudget })) {
        const envelope = await client.rpc(op.method, op.params);
        if (op.expectStatus === undefined) continue;

        const sequence = (await readLedger(stateDir)).length + 1;
        await appendLedgerEntry(stateDir, {
          sequence,
          requestedStatus: op.params.status,
          updatedAt: envelope?.result?.goal?.updatedAt ?? null,
          threadId,
        });

        const setVerdict = assertSetReturnedStatus(envelope, op.expectStatus);
        if (setVerdict.ok) continue;
        const reasons = [...setVerdict.reasons];
        if (setVerdict.observed === 'budgetLimited' && raiseTokenBudget === undefined) {
          reasons.push('raising the token budget needs explicit user confirmation: re-run resume with --raise-token-budget N');
        }
        return {
          outcome: 'terminal_report', threadId, status: setVerdict.observed ?? undefined, reasons,
        };
      }

      return pollGoalUntilTerminal({
        client,
        threadId,
        stateDir,
        attemptNumber,
        binding,
        refreshLease,
        deadline: effectiveDeadlineMs(contract, deadlineMs),
        pollIntervalMs,
        notices,
        turnCounts,
        turnsBaseline,
        turnCap: effectiveCap(MAX_TURNS_PER_ATTEMPT, contract, 'max_turns'),
        // 与 launch 不同：这里认 --raise-token-budget（review M-1），见 resumeTokenCap。
        tokenCap: resumeTokenCap(contract, raiseTokenBudget),
      });
    });
  } catch (error) {
    if (error instanceof AttemptClaimError) throw error;
    return codexAttemptFailure(error, threadId);
  }
}

// finalize：控制器 postflight 全绿、nextAction 返回 finalize_runtime 之后才该被调用——顺序由主会话
// 把关，本函数不自证（CLI 看不到 postflight 结论，自证只会造出一个假的顺序证据）。
// 产物是两份 controller-owned 证据文件，字段与 workflow.mjs 的闭世界形状逐字对齐；归因不过就把
// 两份都写成 ok:false + 安全 reasons（fail-closed：主会话再喂 nextAction 自然被拒，而不是缺文件）。
function verifyNativeTurnFence(envelope, threadId, expectedTurnIds, expectedTurns) {
  const v2 = expectedTurns !== undefined;
  const normalizedExpected = v2 ? expectedTurns : expectedTurnIds;
  if (!Array.isArray(normalizedExpected)
    || normalizedExpected.length === 0
    || (v2 && normalizedExpected.length !== 1)
    || (v2 && normalizedExpected.some((turn) => {
      const keys = Object.keys(turn ?? {}).sort();
      return keys.length !== 2
        || keys[0] !== 'id'
        || keys[1] !== 'input_sha256'
        || typeof turn.id !== 'string'
        || turn.id.length === 0
        || typeof turn.input_sha256 !== 'string'
        || !SHA256.test(turn.input_sha256);
    }))
    || (!v2 && (new Set(normalizedExpected).size !== normalizedExpected.length
      || normalizedExpected.some((id) => typeof id !== 'string' || id.length === 0)))) {
    return { ok: false, reason_codes: ['FINALIZE_TURN_RECEIPT_INVALID'] };
  }
  const thread = envelope?.result?.thread;
  if (thread?.id !== threadId || !Array.isArray(thread.turns)) {
    return { ok: false, reason_codes: ['FINALIZE_NATIVE_READBACK_UNAVAILABLE'] };
  }
  const observedTurns = thread.turns.map(summarizeNativeTurn);
  const observed = observedTurns.map((turn) => turn.id);
  if (observed.some((id) => typeof id !== 'string' || id.length === 0)
    || new Set(observed).size !== observed.length
    || (v2 && observedTurns.some((turn) => !SHA256.test(turn.input_sha256 ?? '')))) {
    return { ok: false, reason_codes: ['FINALIZE_NATIVE_TURN_HISTORY_INVALID'] };
  }
  const expected = new Set(v2
    ? normalizedExpected.map((turn) => `${turn.id}:${turn.input_sha256}`)
    : normalizedExpected);
  const observedKeys = v2
    ? observedTurns.map((turn) => `${turn.id}:${turn.input_sha256}`)
    : observed;
  if (observedKeys.some((key) => !expected.has(key))) {
    return { ok: false, reason_codes: ['UNRECEIPTED_NATIVE_TURN'] };
  }
  if ([...expected].some((key) => !observedKeys.includes(key))) {
    return { ok: false, reason_codes: ['FINALIZE_TURN_RECEIPT_MISMATCH'] };
  }
  return { ok: true, reason_codes: [] };
}

export async function runCodexFinalize({
  stateDir, binding, expectedTurnIds, expectedTurns,
  clientFactory = defaultCodexClientFactory, authSource = DEFAULT_AUTH_SOURCE,
}) {
  const receiptPath = join(stateDir, 'finalization-receipt.json');
  const readbackPath = join(stateDir, 'runtime-readback.json');

  const writeEvidence = async (
    attribution,
    { setStatus = null, readStatus = null, turnFence = null } = {},
  ) => {
    const { ok } = attribution;
    const reasons = ok ? [] : attribution.reasons;
    await writeFile(receiptPath, `${JSON.stringify({
      ok, operation: 'thread/goal/set', status: setStatus, reasons, binding: binding ?? null,
    }, null, 2)}\n`);
    await writeFile(readbackPath, `${JSON.stringify({
      ok,
      source: 'thread/goal/get',
      status: readStatus,
      // 归因不成立时断言不了"没有剩余工作、没有出错"，两项都取 fail-closed 的那一侧。
      remaining_work: !ok,
      error: !ok,
      blocked: readStatus === 'blocked',
      reasons,
      binding: binding ?? null,
    }, null, 2)}\n`);
    return { receiptPath, readbackPath, attribution, turnFence };
  };

  // --binding-file 与 --state 是两个独立入参：对不上意味着这份 receipt 会把某个 run 的 finalize
  // 按到另一份 binding 上。nextAction 只比对 receipt.binding 与主会话手里的 runBinding（同一份
  // 文件，必然自洽），看不见这层错配，只能在这里挡。
  if (binding?.contractHash !== basename(stateDir)) {
    return writeEvidence({
      ok: false,
      reasons: ['runBinding is missing, malformed, or does not match the state directory this run was prepared under'],
    });
  }

  // 陈旧 candidate 的闸（R-2）：最近一次 attempt 自己没产出候选，就没有任何东西可 finalize。
  // 判在起 client 之前——它是零副作用的读盘，没必要先复制凭证、起一个 daemon 再发现。
  const latest = await assertLatestAttemptProducedCandidate(stateDir, binding);
  if (!latest.ok) {
    return writeEvidence({ ok: false, reasons: latest.reasons });
  }

  const session = await readCodexSession(stateDir);
  if (!session.ok) {
    return writeEvidence({ ok: false, reasons: session.reasons });
  }
  const { threadId, codexHome, cwd } = session;

  try {
    return await withCodexClient({
      stateDir, codexHome, cwd, authSource, clientFactory,
    }, async ({ client }) => {
      let turnFence = null;
      if (expectedTurnIds !== undefined || expectedTurns !== undefined) {
        turnFence = verifyNativeTurnFence(
          await client.threadRead({ threadId, includeTurns: true }),
          threadId,
          expectedTurnIds,
          expectedTurns,
        );
        if (!turnFence.ok) {
          return writeEvidence({ ok: false, reasons: turnFence.reason_codes }, { turnFence });
        }
      }
      const setEnvelope = await client.goalSet({ threadId, status: 'complete' });
      const sequence = (await readLedger(stateDir)).length + 1;
      await appendLedgerEntry(stateDir, {
        sequence,
        requestedStatus: 'complete',
        updatedAt: setEnvelope?.result?.goal?.updatedAt ?? null,
        threadId,
      });
      const readbackEnvelope = await client.goalGet({ threadId });
      let attribution = verifyFinalizeAttribution({
        setEnvelope, readbackEnvelope, threadId, sequence, ledger: await readLedger(stateDir),
      });
      if (expectedTurnIds !== undefined || expectedTurns !== undefined) {
        turnFence = verifyNativeTurnFence(
          await client.threadRead({ threadId, includeTurns: true }),
          threadId,
          expectedTurnIds,
          expectedTurns,
        );
        if (!turnFence.ok) attribution = { ok: false, reasons: turnFence.reason_codes };
      }
      return writeEvidence(attribution, {
        setStatus: setEnvelope?.result?.goal?.status ?? null,
        readStatus: readbackEnvelope?.result?.goal?.status ?? null,
        turnFence,
      });
    });
  } catch (error) {
    return writeEvidence({
      ok: false,
      reasons: [`codex finalize failed before attribution could be established: ${error.message}`],
    });
  }
}

// close：残留清理。goal 只要还活着就先 clear——active 是最常见的残留形态，paused/blocked/
// usageLimited/budgetLimited 同样是没收口的活 goal，一并清（complete 已收口，不动）。随后整目录
// 删除 codexHome（withCodexClient 的 cleanup 只删 auth 副本，thread/goal 状态到这一步才该消失）。
export async function runCodexClose({
  stateDir, clientFactory = defaultCodexClientFactory, authSource = DEFAULT_AUTH_SOURCE,
}) {
  // 残留租约的释放**不能**挂在「读得到 codex-home.path」下面（N-2）：崩溃留下的 lease.json 让
  // 下一次 launch 被拦、诊断指向 close，而 close 第一件事就是读 codex-home.path，读不到直接
  // return——launch 说跑 close、close 说没什么可关，两句话互相指认，磁盘状态一动不动，唯一出路
  // 是手工 rm 或换 --controller 名。租约与 codexHome 本来就是两件独立的残留，先把租约收掉。
  const lease = releaseResidualLease({ leasePath: join(stateDir, 'lease.json') });

  let codexHome;
  try {
    codexHome = (await readFile(join(stateDir, 'codex-home.path'), 'utf8')).trim();
  } catch {
    return {
      cleanupComplete: lease.runtimeQuiesced,
      runtimeQuiesced: lease.runtimeQuiesced,
      codexHome: null,
      goalCleared: false,
      leaseReleased: lease.released,
      reasons: [...lease.reasons, lease.released
        // 如实说做了什么：清掉租约之后再说「nothing to close」就是在谎报这次一动没动。
        ? 'no codex-home.path in the state dir: the residual lease was the only thing left to release'
        : 'no codex-home.path in the state dir: nothing to close'],
    };
  }

  // A live foreign runtime lease is proof that the runtime is not quiescent. Do not clear its goal,
  // delete its CODEX_HOME, or tell the controller that cleanup completed: any of those would let the
  // controller release the target-root lease and overlap a new Attempt with the still-running one.
  if (!lease.runtimeQuiesced) {
    return {
      cleanupComplete: false,
      runtimeQuiesced: false,
      codexHome,
      goalCleared: false,
      leaseReleased: false,
      reasons: lease.reasons,
    };
  }

  // 这是全流程唯一的递归删除。路径来自磁盘文件，损坏或被改写就会把 rm -rf 指向任意目录——
  // 只删自己 mkdtemp 出来的那种形态（绝对路径 + gc-codex-home- 前缀），其余一律拒绝并留 reason。
  if (!isAbsolute(codexHome) || !basename(codexHome).startsWith(CODEX_HOME_PREFIX)) {
    return {
      cleanupComplete: false,
      runtimeQuiesced: true,
      codexHome,
      goalCleared: false,
      leaseReleased: lease.released,
      reasons: [...lease.reasons,
        `refusing to delete a codex-home.path outside the managed ${CODEX_HOME_PREFIX}* form`],
    };
  }

  const reasons = [...lease.reasons];
  let goalCleared = false;
  const session = await readCodexSession(stateDir);
  if (session.ok) {
    try {
      await withCodexClient({
        stateDir, codexHome, cwd: session.cwd, authSource, clientFactory,
      }, async ({ client }) => {
        const goal = (await client.goalGet({ threadId: session.threadId }))?.result?.goal;
        if (goal && goal.status !== 'complete') {
          await client.goalClear({ threadId: session.threadId });
          goalCleared = true;
        }
      });
    } catch (error) {
      // daemon 已经不可达时 goal 随 codexHome 一起消失，清理照常往下走，只留 reason。
      reasons.push(`goal clear skipped: ${error.message}`);
    }
  } else {
    reasons.push(...session.reasons);
  }

  rmSync(codexHome, { recursive: true, force: true });
  rmSync(join(stateDir, 'codex-home.path'), { force: true });
  return {
    cleanupComplete: true,
    runtimeQuiesced: true,
    codexHome,
    goalCleared,
    leaseReleased: lease.released,
    reasons,
  };
}

const COMMANDS = {
  prepare: {
    allowed: ['--contract', '--state-root', '--controller'],
    required: ['--contract', '--state-root'],
  },
  launch: {
    allowed: ['--contract', '--state', '--prompt-file', '--binding-file'],
    required: ['--contract', '--state', '--prompt-file', '--binding-file'],
  },
  resume: {
    allowed: ['--contract', '--state', '--diagnostics-file', '--binding-file', '--raise-token-budget'],
    required: ['--contract', '--state', '--diagnostics-file', '--binding-file'],
  },
  finalize: { allowed: ['--state', '--binding-file'], required: ['--state', '--binding-file'] },
  close: { allowed: ['--state'], required: ['--state'] },
  readback: { allowed: ['--state'], required: ['--state'] },
};

function usage() {
  return [
    'Usage:',
    '  node scripts/launch.mjs prepare --contract FILE --state-root PATH [--controller NAME]',
    '  node scripts/launch.mjs launch --contract FILE --state DIR --prompt-file FILE --binding-file FILE',
    '  node scripts/launch.mjs resume --contract FILE --state DIR --diagnostics-file FILE --binding-file FILE [--raise-token-budget N]',
    '  node scripts/launch.mjs finalize --state DIR --binding-file FILE',
    '  node scripts/launch.mjs close --state DIR',
    '  node scripts/launch.mjs readback --state DIR',
    '',
    'readback 是 claude 线的只读观测（transcript 活性、prompt 归因），恒 exit 0：available:false',
    '表示观测不可用，不代表 run 出事；它的结论不进任何证据通道，处置留给人工。',
    '',
    '--raise-token-budget 只在 codex 续跑时可用，且只有显式写出来才会抬预算：预算仅用户明给，',
    '这个 flag 就是那份用户确认的载体，缺省绝不自动抬。',
    '',
    '--diagnostics-file 收的是一份红项清单，不是自由文本——注入给执行体的那段话由本脚本按 contract',
    `渲染，编排器只声明「哪几条红了、退出码多少」：${DIAGNOSTICS_SHAPE}`,
    'entry 必须是本 contract 的 postflight 条目 id（命令与 cwd 从 contract 取，不从这个文件读），',
    `code 只认可续类 ${RESUMABLE_CODES.join(' / ')}。执行体产出的字节一律不得进入这个通道。`,
  ].join('\n');
}

export function parseArgs(argv) {
  const command = argv[0];
  const spec = COMMANDS[command];
  if (!spec) throw new Error(usage());
  const values = {};
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined || !spec.allowed.includes(flag) || values[flag] !== undefined) {
      throw new Error(usage());
    }
    values[flag] = value;
  }
  for (const flag of spec.required) {
    if (!values[flag]) throw new Error(usage());
  }
  return { command, values };
}

// binding 文件缺失或 JSON 损坏都归一为 undefined——runClaudeAttempt 自己的三方交叉判定会
// 统一 fail-closed（未定义的 contractHash 永远对不上 stateDir 末段），不重复这段判定逻辑。
async function readBindingFile(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

async function runPrepareCommand(values) {
  const contractPath = values['--contract'];
  const contract = await readContract(contractPath);
  const hash = contractHash(contract);
  const stateDir = stateDirFor({ stateRoot: values['--state-root'], controller: values['--controller'] ?? 'default', contractHash: hash });
  if (contract.runtime === 'claude') {
    const result = await prepareClaude({ contract, contractPath, stateDir });
    process.stdout.write(`${JSON.stringify({
      runtime: 'claude', stateDir, contractHash: hash, settingsPath: result.settingsPath, hookScriptPath: result.hookScriptPath,
    })}\n`);
    return;
  }
  if (contract.runtime === 'codex') {
    const result = await prepareCodexProbesOnly({ stateDir });
    process.stdout.write(`${JSON.stringify({ runtime: 'codex', stateDir: result.stateDir, contractHash: hash })}\n`);
    return;
  }
  throw new Error(`unsupported runtime: ${contract.runtime}`);
}

// 显式传入才抬预算：不传就是 undefined，resumeRpcOps 据此省略 tokenBudget 参数。
export function parseRaiseTokenBudget(values) {
  const raw = values['--raise-token-budget'];
  if (raw === undefined) return undefined;
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error('--raise-token-budget must be a positive integer');
  return Number(raw);
}

async function runAttemptCommand(command, values) {
  const contract = await readContract(values['--contract']);
  const stateDir = values['--state'];
  const binding = await readBindingFile(values['--binding-file']);
  // 长内容先落权限受控文件，读文件 bytes 再以单一 argv 传给 claude（不拼 shell 字符串）。
  const prompt = command === 'launch' ? await readFile(values['--prompt-file'], 'utf8') : undefined;
  // 注入文本不由这份文件直接充当：它只声明「哪几条 contract 声明过的 postflight 条目红了、退出码
  // 是多少」，文本由 compileResumeDiagnostic 按 contract 渲染（见那里的成因）。形状不合即进程级失败，
  // 与「diagnostics 文件读不出」同一格（exit 1）：把不合形状的文件放行才是这条闸的失效方式。
  const diagnostic = command === 'resume'
    ? compileResumeDiagnostic({ text: await readFile(values['--diagnostics-file'], 'utf8'), contract })
    : { ok: true, text: undefined };
  if (!diagnostic.ok) throw new Error(diagnostic.reasons.join('\n'));
  const diagnosticText = diagnostic.text;
  const raiseTokenBudget = parseRaiseTokenBudget(values);

  // outcome=terminal_report 与「起飞且拿到候选」此前同为 exit 0，「根本没起飞」因此对只读退出码
  // 的编排器不可见（第二次冒烟 N-1）。改置 3：与进程级失败(1)、usage(2) 各自区分开，读退出码
  // 也 fail-closed。stdout 的报告体仍是唯一权威，reasons 只在那里。
  const emit = (result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.outcome === 'terminal_report') process.exitCode = 3;
  };

  if (contract.runtime === 'codex') {
    emit(command === 'launch'
      ? await runCodexLaunch({
        contract, stateDir, binding, prompt,
      })
      : await runCodexResume({
        contract, stateDir, binding, diagnosticText, raiseTokenBudget,
      }));
    return;
  }

  // claude 侧没有 tokenBudget 这个原生参数——静默忽略会让操作员以为预算抬上去了。
  if (raiseTokenBudget !== undefined) {
    throw new Error('--raise-token-budget only applies to the codex runtime');
  }
  emit(await runClaudeAttempt({
    contract, stateDir, binding, prompt, kind: command, diagnosticText,
  }));
}

// finalize 的判定权威始终是它写出的两份证据文件里的 `ok`（nextAction 读的就是那两份），退出码
// 只是给编排器的粗信号。但「归因不成立」此前与「归因成立」同为 exit 0——与 launch/resume 改置 3
// 之后的语义不一致，读退出码的编排器在这一格上仍然 fail-open。归因不成立即 exit 3，四格对齐。
async function runFinalizeCommand(values) {
  const binding = await readBindingFile(values['--binding-file']);
  const result = await runCodexFinalize({ stateDir: values['--state'], binding });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.attribution.ok) process.exitCode = 3;
}

async function runCloseCommand(values) {
  const result = await runCodexClose({ stateDir: values['--state'] });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.cleanupComplete !== true) process.exitCode = 3;
}

async function runCli() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  try {
    if (parsed.command === 'prepare') {
      await runPrepareCommand(parsed.values);
      return;
    }
    if (parsed.command === 'finalize') {
      await runFinalizeCommand(parsed.values);
      return;
    }
    if (parsed.command === 'close') {
      await runCloseCommand(parsed.values);
      return;
    }
    if (parsed.command === 'readback') {
      // 观测工具恒 exit 0：available:false 是「看不到」不是「出事了」，把它标成非零会诱导编排器
      // 把观测缺席当成 run 故障处理。
      process.stdout.write(`${JSON.stringify(await runClaudeReadback({ stateDir: parsed.values['--state'] }))}\n`);
      return;
    }
    await runAttemptCommand(parsed.command, parsed.values);
  } catch (error) {
    process.stderr.write(`${renderCliError(error)}\n`);
    process.exitCode = 1;
  }
}

// ContractArtifactError 的 message 只有 code+path；observed/expected/next 若只在字段里，launch CLI
// 的操作员永远看不到（validate-contract.mjs 渲染、这边不渲染，V7'）。两边同一格式，单点在此。
export function renderCliError(error) {
  if (error?.code && error?.path && error?.expected && error?.next) {
    return `${error.code} ${error.path} observed=${JSON.stringify(error.observed)} `
      + `expected=${JSON.stringify(error.expected)} next=${JSON.stringify(error.next)}`;
  }
  return error?.message ?? String(error);
}

// Node 默认对模块做 realpath 解析，而 process.argv[1] 保留调用者敲入的字面路径。只比字面路径时，
// 任何经 symlink 的调用（已安装 skill 根目录本身就是 symlink）都会判定为「非入口」，runCli() 不执行、
// 进程 exit 0 且 stdout 为空——把「根本没启动」伪装成「启动成功」。
// 解法是两侧都归一化到 realpath 再比：Node 的两种解析姿态（默认 realpath 解析、
// --preserve-symlinks-main 保留字面）由此都落到同一个 canonical 形态上，不存在「两者都不匹配却确实
// 是入口」的形态。归一化失败（路径不存在等）时退回原字符串参与比较，绝不抛。
// 不要在这里加「文件名相同就当入口」之类的兜底：runCli() 会用宿主的 argv 分派 prepare/launch/
// resume/finalize/close 中的任意一条并覆写宿主 exitCode，那不是「多打一遍 usage」，是在别人的进程里
// 执行子命令。
export function isCliEntry(entryPath, moduleUrl) {
  if (typeof entryPath !== 'string' || entryPath.length === 0) return false;
  return canonicalPath(entryPath) === canonicalPath(fileURLToPath(moduleUrl));
}

if (isCliEntry(process.argv[1], import.meta.url)) {
  await runCli();
}
