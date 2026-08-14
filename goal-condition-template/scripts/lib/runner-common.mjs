// Runtime-neutral controller state, claims, attempt accounting, and diagnostics.
import { constants, existsSync, realpathSync } from 'node:fs';
import {
  chmod, link, lstat, mkdir, open, readdir, rm, writeFile,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

export const MAX_AUTO_RESUMES = 2;

// 路径归一。同一个目录在两侧可能各拿到 symlink 的一边（contract 写字面路径、服务端回真实路径，
// 或反过来），逐字比较会把同一个目录判成两个。归一化失败（路径不存在、入参不是字符串）时退回原值，
// 绝不抛——调用方要么在比字符串，要么已经准备好接住一个非字符串并如实判红。
export function canonicalPath(pathname) {
  try {
    return realpathSync(pathname);
  } catch {
    return pathname;
  }
}

// targetRoots/additionalReadRoots 是 launch 时刻的全量 canonical 授权面（V2'）：cwd 只覆盖
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

// Never stream bytes into the public claim path. A failed write there would require unlinking a mutable pathname,
// which can delete a foreign replacement created after our descriptor was closed. Instead, fully write and fsync a
// unique same-directory inode, publish it with an atomic no-replace hard link, then remove only the private name.
// The final path is therefore either absent, foreign and untouched, or a complete single-link regular file.
export async function writeControllerJsonExclusive(pathname, value, {
  writeImpl = async (handle, bytes) => handle.writeFile(bytes, 'utf8'),
} = {}) {
  const privatePath = join(dirname(pathname), `.${basename(pathname)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(privatePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    const st = await handle.stat({ bigint: true });
    if (!st.isFile() || st.nlink !== 1n) throw new Error('exclusive controller claim is not a single-link regular file');
    await writeImpl(handle, JSON.stringify(value, null, 2));
    await handle.sync();
    await link(privatePath, pathname);
    await rm(privatePath);
    return { dev: st.dev.toString(), ino: st.ino.toString() };
  } catch (error) {
    if (handle) {
      try { await handle.close(); } catch { /* preserve the original write failure */ }
      handle = undefined;
    }
    // privatePath is an unguessable Controller-owned name. Never remove pathname here: a failed link means that
    // name may belong to another process, and a failed write may have allowed a test/fault injector to create it.
    try { await rm(privatePath, { force: true }); } catch { /* preserve the original publication failure */ }
    throw error;
  } finally {
    if (handle) await handle.close();
  }
}

export async function removeOwnedControllerFile(pathname, ownership) {
  const st = await lstat(pathname, { bigint: true });
  if (!st.isFile() || st.nlink !== 1n
    || st.dev.toString() !== ownership?.dev || st.ino.toString() !== ownership?.ino) {
    throw new Error('controller claim ownership changed before rollback');
  }
  await rm(pathname);
}
export function stateDirFor({ stateRoot, controller = 'default', contractHash }) {
  return join(stateRoot, controller, contractHash);
}

export async function initStateDir(dir) {
  await mkdir(dir, { recursive: true });
  await chmod(dir, 0o700);
  await mkdir(join(dir, 'attempts'), { recursive: true });
}

export async function maxExistingAttempt(stateDir) {
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
// 调用点必须落在所有前置闸之后（claude.md 的计数口径是「真实跑过的轮次」）。默认占位是
// durable 的；Claude 线只在 state 级独占 lease 内允许 pre-dispatch rollback，此时不会有更高编号
// 并发出现。真实 dispatch 之后仍不可撤销，prepare 与 close 都不清 attempts/。
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
export const DIAGNOSTICS_SHAPE = '{"reds":[{"entry":"<postflight entry id>","code":"'
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
