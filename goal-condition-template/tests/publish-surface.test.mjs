import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

// 发布面泄漏闸：整个仓库——不是某几个目录——不得含可关联到某台机器或某个人的标识符。
//
// 为什么不复用 static.test.mjs 里那道 Markdown 隐私闸：那道闸守的是「loader 会读进上下文的
// Markdown」，关注点里还有 $1 展开这类 loader hazard，覆盖面按设计就只有 SKILL.md 与
// references/。真实泄漏出现在它覆盖不到的地方——docs/ 的 plan 文档、spikes/ 的 fixture、
// 探测脚本的注释——并一路活到公开发布前才被人工扫出来。两道闸关注点不同，不合并。
//
// 判据一律按**模式类**穷举，不按已知样例枚举。人工审计时的教训：先按 `/Users/` 前缀列了一张
// 「待脱敏清单」，结果 `/private/tmp/claude-501/-Users-…-<project>-…/` 因为不以 `/Users/` 开头
// 整条漏网，而它恰恰泄漏了项目名。清单只配当核对用，不配当发现用。
//
// 合成占位值靠**形态**与真值区分，不靠白名单：合成 UUID 的首段是 8 个相同字符，真实 UUID 不是。
// 这样新增一个合成值不需要来改这里，而漏掉一个真值也不会被某张清单放行。

const repositoryRoot = resolve(import.meta.dirname, '../..');

// 字面量会命中检测器自身，所以下面这些片段一律拼出来。
const USER_DIR = '/' + 'Users' + '/';
const HOME_DIR = '/' + 'home' + '/';
const VAR_FOLDERS = '/' + 'var' + '/folders/';

// 家目录绝对路径。后面必须跟一个小写字母（即真的有用户名）——文档里写 `/Users/` 讲规则、
// 或检测器正则写 `/Users/|/home/`，后面跟的是反引号或竖线，天然不命中，无需豁免机制。
const HOME_PATH = new RegExp(`(?:${USER_DIR}|${HOME_DIR})[a-z]`);

// macOS 的 per-user temp folder salt：每个用户唯一且长期稳定，是可关联标识符。
const TMPDIR_SALT = new RegExp(`${VAR_FOLDERS}[a-z0-9]{2}/[A-Za-z0-9_]{16,}`);

// 真实 UUID：首段 8 个字符不全相同。合成占位（00000000-…/11111111-…）因此自动放行。
const REAL_UUID = /\b(?!([0-9a-f])\1{7}\b)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/;

// 凭证：长度下限把文档里的正则字面量（`sk-[A-Za-z0-9]` 这类）挡在外面。
const CREDENTIAL = new RegExp([
  'sk' + '-[A-Za-z0-9]{16,}',
  'gh' + '[pousr]_[A-Za-z0-9]{16,}',
  'AK' + 'IA[0-9A-Z]{16}',
  'BEGIN [A-Z ]*PRIVATE KEY',
  'ey' + 'J[A-Za-z0-9_-]{20,}\\.',
].join('|'));

// 邮箱：RFC 保留的测试域（.invalid/.example/.test）与 example.com 放行，其余一律算真实地址。
const REAL_EMAIL = /\b[A-Za-z0-9._%+-]+@(?!example\.com\b)[A-Za-z0-9.-]+\.(?!invalid\b|example\b|test\b)[A-Za-z]{2,}\b/;

// 每个 sample 都拼出来，且用合成值而非曾经泄漏过的真值。这道闸扫的是**源文件文本**，
// 而本文件自己也在扫描范围内——写成连续字面量会让这道闸抓住它自己。
// （这不是假设：本文件未被 git 跟踪时全绿，commit 之后立刻落红，就是这条。）
const DETECTORS = [
  { name: 'home directory path', pattern: HOME_PATH, sample: USER_DIR + 'alice/workspace/notes.md' },
  { name: 'per-user temp folder salt', pattern: TMPDIR_SALT, sample: VAR_FOLDERS + 'c3/' + 'a'.repeat(28) + '/T' },
  { name: 'real uuid', pattern: REAL_UUID, sample: '0123' + '4567-89ab-4cde-8f01-23456789abcd' },
  { name: 'credential', pattern: CREDENTIAL, sample: 'sk' + '-abcdefghijklmnopqrstuvwx' },
  { name: 'real email address', pattern: REAL_EMAIL, sample: 'sample' + '@' + 'not-a-real-domain.com' },
];

// 合成占位必须被放行——否则这道闸会逼着后来的人把占位值也改掉，最后被整个注释掉。
const SYNTHETIC_ALLOWED = [
  '00000000-0000-4000-8000-000000000001',
  '11111111-1111-4111-8111-000000000002',
  '22222222-2222-4222-8222-000000000003',
  'installer-test@example.invalid',
  USER_DIR + '`、`' + HOME_DIR,          // 文档里讲「不得含这两种路径」的写法
  "rg -n '" + USER_DIR + '|' + HOME_DIR + "'", // 检测器正则本身
];

function trackedFiles() {
  try {
    return execFileSync('git', ['ls-files', '-z'], { cwd: repositoryRoot, encoding: 'utf8' })
      .split('\0').filter(Boolean);
  } catch {
    // 不在 git 工作树里（tarball 分发）时回退到文件树遍历，绝不因为拿不到清单就跳过检查。
    const skip = new Set(['.git', '.superpowers', 'node_modules']);
    const walk = (dir) => readdirSync(join(repositoryRoot, dir || '.'), { withFileTypes: true })
      .flatMap((entry) => {
        if (skip.has(entry.name)) return [];
        const rel = dir ? `${dir}/${entry.name}` : entry.name;
        return entry.isDirectory() ? walk(rel) : [rel];
      });
    return walk('');
  }
}

test('leak detectors match representative real values and clear synthetic placeholders', () => {
  // 没有这条，正则写错就变成一道永远绿的空闸——这类「测试说谎」比没有测试更糟。
  for (const { name, pattern, sample } of DETECTORS) {
    assert.match(sample, pattern, `${name} detector missed its representative sample`);
  }
  for (const allowed of SYNTHETIC_ALLOWED) {
    for (const { name, pattern } of DETECTORS) {
      assert.doesNotMatch(allowed, pattern, `${name} detector false-positives on synthetic value: ${allowed}`);
    }
  }
});

test('no tracked file leaks machine-identifying data anywhere in the repository', () => {
  const files = trackedFiles();
  assert.ok(files.length > 20, `tracked file listing looks empty (${files.length}) — the gate would pass vacuously`);

  const findings = [];
  for (const relativePath of files) {
    const absolute = join(repositoryRoot, relativePath);
    if (!existsSync(absolute)) continue;
    const buffer = readFileSync(absolute);
    if (buffer.includes(0)) continue;             // 二进制按内容判，不按扩展名枚举
    const lines = buffer.toString('utf8').split('\n');
    lines.forEach((line, index) => {
      for (const { name, pattern } of DETECTORS) {
        if (pattern.test(line)) findings.push(`${relativePath}:${index + 1}: ${name}`);
      }
    });
  }
  assert.deepEqual(findings, [], `machine-identifying data found in tracked files:\n${findings.join('\n')}`);
});
