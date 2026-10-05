import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repositoryRoot = resolve(import.meta.dirname, '..');
const canonicalPath = join(repositoryRoot, 'shared/goal-semantics.md');
const claudeSkillRoot = join(repositoryRoot, 'goal-condition-template');
const codexSkillRoot = join(repositoryRoot, 'codex-native/skills/goal-condition');
const read = (pathname) => readFileSync(pathname, 'utf8');

// 两个 runtime 的 skill 各自独立安装，运行时读不到仓库根目录，所以共享语义只能以副本随包分发。
// 副本一旦手改就会悄悄分叉，两边又回到「同名 skill、不同规则」——这正是 2026-10-05 要修的问题。
test('each runtime skill ships a byte-identical copy of the shared goal semantics', () => {
  const canonical = readFileSync(canonicalPath);
  for (const root of [claudeSkillRoot, codexSkillRoot]) {
    const copy = readFileSync(join(root, 'references/goal-semantics.md'));
    assert.ok(copy.equals(canonical), `${root} has drifted from shared/goal-semantics.md`);
  }
});

test('both runtime skills route readers to the shared semantics', () => {
  for (const root of [claudeSkillRoot, codexSkillRoot]) {
    assert.match(read(join(root, 'SKILL.md')), /\]\(references\/goal-semantics\.md\)/,
      `${root}/SKILL.md does not link the shared semantics`);
  }
});

// 共享层只放两边都成立的语义。启动通道、长度上限、预算接口与判定者都是 runtime 事实，
// 写进共享层就会被另一边当成自己的规则。
test('shared semantics stay free of runtime-specific launch facts', () => {
  const shared = read(canonicalPath);
  for (const runtimeFact of [
    'ProposeGoal', 'create_goal', 'update_goal', 'token_budget', 'pbcopy', '4000', '500 字符',
  ]) {
    assert.equal(shared.includes(runtimeFact), false, `shared semantics contain runtime fact ${runtimeFact}`);
  }
});

test('Codex skill does not inherit Claude evaluator or clipboard rules', () => {
  const skill = read(join(codexSkillRoot, 'SKILL.md'));
  for (const claudeOnly of ['ProposeGoal', '4000', 'only sees the transcript', '只看 transcript', 'pbpaste']) {
    assert.equal(skill.includes(claudeOnly), false, `Codex skill claims Claude mechanism ${claudeOnly}`);
  }
});
