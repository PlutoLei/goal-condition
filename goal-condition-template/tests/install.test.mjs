import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import test from 'node:test';
import { installRelease, verifyRelease, REQUIRED_CORE_FILES } from '../scripts/lib/installer.mjs';

const execFile = promisify(execFileCallback);

async function git(repo, args) {
  return execFile('git', ['-C', repo, ...args], { encoding: 'utf8' });
}

async function mode(pathname) {
  return (await lstat(pathname)).mode & 0o7777;
}

async function writeSourceFile(repo, relativePath, content) {
  const pathname = join(repo, 'goal-condition-template', relativePath);
  await mkdir(join(pathname, '..'), { recursive: true });
  await writeFile(pathname, content);
}

async function createSourceRepository(t) {
  const root = await mkdtemp(join(tmpdir(), 'goal-installer-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'source');
  await mkdir(repo);
  await git(repo, ['init', '--initial-branch=main']);
  await git(repo, ['config', 'user.name', 'Installer Test']);
  await git(repo, ['config', 'user.email', 'installer-test@example.invalid']);

  await writeSourceFile(repo, 'SKILL.md', '# old core\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'incomplete old core']);
  const incompleteCommit = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();

  // 逐项写死 15 个路径曾经与 REQUIRED_CORE_FILES 各说各话地漂移（task-16-report.md 盲区 2）：
  // 常量少一项，这里的旧字面清单不会跟着变小，测试照样全绿。改成从常量派生，新增/改名的核心
  // 文件不用再手改这份清单；常量真正的完整性守护见 static.test.mjs 的磁盘对账。
  for (const relativePath of REQUIRED_CORE_FILES) {
    if (relativePath === 'SKILL.md') continue; // 上面已用固定内容写过，下面的断言依赖那个字面值
    const content = relativePath === 'codex-controller/package.json'
      ? await readFile(new URL('../codex-controller/package.json', import.meta.url), 'utf8')
      : `export const marker = ${JSON.stringify(relativePath)};\n`;
    await writeSourceFile(repo, relativePath, content);
  }
  await writeSourceFile(repo, 'references/anchors-and-rules.md', '# public template\n');
  await chmod(join(repo, 'goal-condition-template', 'scripts', 'install.mjs'), 0o755);
  await writeSourceFile(repo, 'tests/must-not-install.test.mjs', 'throw new Error("not core");\n');
  await writeFile(join(repo, 'README.md'), '# excluded\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'old core']);
  const oldCommit = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();

  await writeSourceFile(repo, 'SKILL.md', '# new worktree content\n');
  await git(repo, ['add', 'goal-condition-template/SKILL.md']);
  await git(repo, ['commit', '-m', 'new worktree content']);
  const newCommit = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
  return { root, repo, incompleteCommit, oldCommit, newCommit };
}

test('materializes an immutable release from the requested commit without profile leakage', async (t) => {
  const { root, repo, oldCommit } = await createSourceRepository(t);
  const profile = join(root, 'private-profile.md');
  const releaseRoot = join(root, 'releases');
  const claudeLink = join(root, 'claude-skill');
  const codexLink = join(root, 'codex-skill');
  await writeFile(profile, '# private project anchors\n');

  const result = await installRelease({
    repo,
    ref: oldCommit.slice(0, 12),
    profile,
    releaseRoot,
    links: { claude: claudeLink, codex: codexLink },
  });

  assert.equal(result.commit, oldCommit);
  assert.equal(result.releaseDir, join(await realpath(releaseRoot), oldCommit));
  assert.equal(await readFile(join(result.releaseDir, 'SKILL.md'), 'utf8'), '# old core\n');
  assert.equal(await readFile(join(result.releaseDir, 'references', 'anchors-and-rules.md'), 'utf8'), '# private project anchors\n');
  assert.equal(await realpath(claudeLink), await realpath(codexLink));
  assert.equal(await realpath(claudeLink), await realpath(result.releaseDir));
  assert.match(result.manifestDigest, /^[0-9a-f]{64}$/);

  const manifestText = await readFile(join(result.releaseDir, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.commit, oldCommit);
  assert.match(manifest.profile_sha256, /^[0-9a-f]{64}$/);
  assert.equal(manifest.source_files.some((entry) => entry.path.includes('anchors-and-rules')), false);
  assert.equal(manifest.source_files.some((entry) => entry.path.includes('tests/')), false);
  assert.equal(manifest.source_files.some((entry) => entry.path.includes('README')), false);
  assert.equal(manifest.source_files.find((entry) => entry.path === 'scripts/install.mjs').mode, '100755');
  const controllerEntries = manifest.source_files
    .filter((entry) => entry.path.startsWith('codex-controller/'));
  assert.ok(controllerEntries.length > 0, 'release manifest must include the Codex controller');
  assert.equal(controllerEntries.some((entry) => entry.path.includes('/tests/')), false);
  for (const entry of controllerEntries) {
    const installedBytes = await readFile(join(result.releaseDir, entry.path));
    assert.equal(createHash('sha256').update(installedBytes).digest('hex'), entry.sha256, entry.path);
    assert.match(entry.mode, /^100(?:644|755)$/);
  }
  const installedControllerPackage = JSON.parse(
    await readFile(join(result.releaseDir, 'codex-controller', 'package.json'), 'utf8'),
  );
  assert.equal(installedControllerPackage.engines.node, '>=24.15.0');
  // 安装器正确性断言，不构成闭包守卫：两侧同源，都是同一个 REQUIRED_CORE_FILES（一侧是
  // installRelease 内部拿它去过滤 git tree，另一侧是这里直接读常量），测的是「安装器有没有
  // 老实按常量转录」，不是「常量本身有没有漂移」——常量真正的独立守护在 static.test.mjs 那条
  // 磁盘对账测试（真相源是 readdirSync 的文件树，不是常量自己），别把这条当第二道防线。
  assert.deepEqual(
    manifest.source_files.map((entry) => entry.path).sort(),
    [...REQUIRED_CORE_FILES].sort(),
    'installed manifest source_files must be exactly REQUIRED_CORE_FILES, no more and no fewer',
  );
  assert.equal(await mode(releaseRoot), 0o755);
  assert.equal(await mode(result.releaseDir), 0o755);
  for (const directory of [
    'references', 'references/adapters', 'schema', 'scripts', 'scripts/lib',
    'codex-controller', 'codex-controller/schema', 'codex-controller/src',
  ]) {
    assert.equal(await mode(join(result.releaseDir, directory)), 0o755, directory);
  }
  assert.equal(await mode(join(result.releaseDir, 'SKILL.md')), 0o644);
  assert.equal(await mode(join(result.releaseDir, 'scripts', 'install.mjs')), 0o755);
  assert.equal(await mode(join(result.releaseDir, 'references', 'anchors-and-rules.md')), 0o600);
  assert.equal(await mode(join(result.releaseDir, 'manifest.json')), 0o644);
  assert.equal(manifestText.includes(repo), false);
  assert.equal(manifestText.includes(profile), false);
  assert.equal((await readFile(join(result.releaseDir, 'SKILL.md'), 'utf8')).includes(repo), false);
  assert.deepEqual(await verifyRelease(result.releaseDir, {
    expectedManifestDigest: result.manifestDigest,
  }), { ok: true, drift: [], manifestDigest: result.manifestDigest });

  const again = await installRelease({
    repo,
    ref: oldCommit,
    profile,
    releaseRoot,
    links: { claude: claudeLink, codex: codexLink },
  });
  assert.equal(again.releaseDir, result.releaseDir);
  assert.equal(again.manifestDigest, result.manifestDigest);
});

test('reports release drift after a core file is modified', async (t) => {
  const { root, repo, oldCommit } = await createSourceRepository(t);
  const profile = join(root, 'private-profile.md');
  await writeFile(profile, '# private project anchors\n');
  const { releaseDir, manifestDigest } = await installRelease({
    repo,
    ref: oldCommit,
    profile,
    releaseRoot: join(root, 'releases'),
    links: { claude: join(root, 'claude-skill'), codex: join(root, 'codex-skill') },
  });

  await writeFile(join(releaseDir, 'SKILL.md'), '# tampered\n');
  const verification = await verifyRelease(releaseDir, { expectedManifestDigest: manifestDigest });
  assert.equal(verification.ok, false);
  assert.ok(verification.drift.some((entry) => entry.code === 'SOURCE_FILE_HASH_MISMATCH'
    && entry.path === 'SKILL.md'));
});

test('reports release drift after a core file mode is modified', async (t) => {
  const { root, repo, oldCommit } = await createSourceRepository(t);
  const profile = join(root, 'private-profile.md');
  await writeFile(profile, '# private project anchors\n');
  const { releaseDir, manifestDigest } = await installRelease({
    repo, ref: oldCommit, profile, releaseRoot: join(root, 'releases'),
    links: { claude: join(root, 'claude-skill'), codex: join(root, 'codex-skill') },
  });

  await chmod(join(releaseDir, 'SKILL.md'), 0o755);
  const verification = await verifyRelease(releaseDir, { expectedManifestDigest: manifestDigest });
  assert.equal(verification.ok, false);
  assert.ok(verification.drift.some((entry) => entry.code === 'SOURCE_FILE_MODE_MISMATCH'
    && entry.path === 'SKILL.md'));
});

test('Codex controller production bytes and mode remain externally manifest-bound', async (t) => {
  const { root, repo, oldCommit } = await createSourceRepository(t);
  const profile = join(root, 'private-profile.md');
  await writeFile(profile, '# private project anchors\n');
  const { releaseDir, manifestDigest } = await installRelease({
    repo, ref: oldCommit, profile, releaseRoot: join(root, 'releases'),
    links: { claude: join(root, 'claude-skill'), codex: join(root, 'codex-skill') },
  });
  const controllerPath = join(releaseDir, 'codex-controller', 'src', 'domain.mjs');
  const original = await readFile(controllerPath);

  await writeFile(controllerPath, 'export const tampered = true;\n');
  const hashDrift = await verifyRelease(releaseDir, { expectedManifestDigest: manifestDigest });
  assert.equal(hashDrift.ok, false);
  assert.ok(hashDrift.drift.some((entry) => entry.code === 'SOURCE_FILE_HASH_MISMATCH'
    && entry.path === 'codex-controller/src/domain.mjs'));

  await writeFile(controllerPath, original);
  await chmod(controllerPath, 0o755);
  const modeDrift = await verifyRelease(releaseDir, { expectedManifestDigest: manifestDigest });
  assert.equal(modeDrift.ok, false);
  assert.ok(modeDrift.drift.some((entry) => entry.code === 'SOURCE_FILE_MODE_MISMATCH'
    && entry.path === 'codex-controller/src/domain.mjs'));
});

test('rejects setuid, setgid, and sticky mode bits on every release policy class', async (t) => {
  const { root, repo, oldCommit } = await createSourceRepository(t);
  const profile = join(root, 'private-profile.md');
  const releaseRoot = join(root, 'releases');
  await writeFile(profile, '# private project anchors\n');
  const { releaseDir, manifestDigest } = await installRelease({
    repo, ref: oldCommit, profile, releaseRoot,
    links: { claude: join(root, 'claude-skill'), codex: join(root, 'codex-skill') },
  });

  const cases = [
    ['core file reproduced 04644', join(releaseDir, 'SKILL.md'), 0o4644, 0o644,
      'SOURCE_FILE_MODE_MISMATCH', 'SKILL.md'],
    ['profile file setgid', join(releaseDir, 'references', 'anchors-and-rules.md'), 0o2600, 0o600,
      'PROFILE_MODE_MISMATCH', 'references/anchors-and-rules.md'],
    ['manifest file sticky', join(releaseDir, 'manifest.json'), 0o1644, 0o644,
      'MANIFEST_MODE_MISMATCH', 'manifest.json'],
    ['release root sticky', releaseRoot, 0o1755, 0o755,
      'RELEASE_ROOT_MODE_MISMATCH', '..'],
    ['release directory setuid', releaseDir, 0o4755, 0o755,
      'RELEASE_DIRECTORY_MODE_MISMATCH', '.'],
    ['required directory setgid', join(releaseDir, 'references'), 0o2755, 0o755,
      'RELEASE_DIRECTORY_MODE_MISMATCH', 'references'],
  ];

  for (const [name, pathname, mutated, expected, code, driftPath] of cases) {
    await t.test(name, async () => {
      await chmod(pathname, mutated);
      assert.equal(await mode(pathname), mutated, 'test fixture preserved the special mode bit');
      const verification = await verifyRelease(releaseDir, { expectedManifestDigest: manifestDigest });
      assert.equal(verification.ok, false);
      assert.ok(verification.drift.some((entry) => entry.code === code
        && entry.path === driftPath
        && entry.observed === mutated.toString(8).padStart(4, '0')
        && entry.expected === expected.toString(8).padStart(4, '0')));
      await chmod(pathname, expected);
    });
  }
});

test('external manifest digest rejects a tampered core with a recomputed manifest', async (t) => {
  const { root, repo, oldCommit } = await createSourceRepository(t);
  const profile = join(root, 'private-profile.md');
  await writeFile(profile, '# private project anchors\n');
  const installed = await installRelease({
    repo, ref: oldCommit, profile, releaseRoot: join(root, 'releases'),
    links: { claude: join(root, 'claude-skill'), codex: join(root, 'codex-skill') },
  });

  const tampered = Buffer.from('# attacker recomputed core\n');
  await writeFile(join(installed.releaseDir, 'SKILL.md'), tampered);
  const manifestPath = join(installed.releaseDir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.source_files.find((entry) => entry.path === 'SKILL.md').sha256 = createHash('sha256').update(tampered).digest('hex');
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const verification = await verifyRelease(installed.releaseDir, {
    expectedManifestDigest: installed.manifestDigest,
  });
  assert.equal(verification.ok, false);
  assert.ok(verification.drift.some((entry) => entry.code === 'MANIFEST_DIGEST_MISMATCH'));
  await assert.rejects(
    installRelease({
      repo, ref: oldCommit, profile, releaseRoot: join(root, 'releases'),
      links: { claude: join(root, 'claude-skill'), codex: join(root, 'codex-skill') },
    }),
    (error) => error.code === 'RELEASE_DRIFT',
  );
});

test('verifyRelease requires an externally retained lowercase manifest digest', async (t) => {
  const { root, repo, oldCommit } = await createSourceRepository(t);
  const profile = join(root, 'private-profile.md');
  await writeFile(profile, '# private project anchors\n');
  const installed = await installRelease({
    repo, ref: oldCommit, profile, releaseRoot: join(root, 'releases'),
    links: { claude: join(root, 'claude-skill'), codex: join(root, 'codex-skill') },
  });

  for (const expectedManifestDigest of [undefined, installed.manifestDigest.toUpperCase(), '0'.repeat(63)]) {
    const verification = await verifyRelease(installed.releaseDir, { expectedManifestDigest });
    assert.equal(verification.ok, false);
    assert.ok(verification.drift.some((entry) => entry.code === 'EXPECTED_MANIFEST_DIGEST_REQUIRED'));
  }
});

test('rejects an incomplete pinned commit before release or link mutation', async (t) => {
  const { root, repo, incompleteCommit } = await createSourceRepository(t);
  const profile = join(root, 'private-profile.md');
  const releaseRoot = join(root, 'releases');
  const claudeLink = join(root, 'claude-skill');
  const codexLink = join(root, 'codex-skill');
  await writeFile(profile, '# private project anchors\n');

  await assert.rejects(
    installRelease({
      repo, ref: incompleteCommit, profile, releaseRoot,
      links: { claude: claudeLink, codex: codexLink },
    }),
    (error) => error.code === 'CORE_SOURCE_MISSING' && Array.isArray(error.missing),
  );
  await assert.rejects(lstat(join(releaseRoot, incompleteCommit)), { code: 'ENOENT' });
  await assert.rejects(lstat(claudeLink), { code: 'ENOENT' });
  await assert.rejects(lstat(codexLink), { code: 'ENOENT' });
});

test('refuses ordinary link targets unless an explicit backup location preserves them', async (t) => {
  const { root, repo, oldCommit } = await createSourceRepository(t);
  const profile = join(root, 'private-profile.md');
  const releaseRoot = join(root, 'releases');
  const claudeLink = join(root, 'claude-skill');
  const codexLink = join(root, 'codex-skill');
  await writeFile(profile, '# private project anchors\n');
  await mkdir(claudeLink);
  await writeFile(join(claudeLink, 'keep.txt'), 'recover me\n');

  await assert.rejects(
    installRelease({
      repo, ref: oldCommit, profile, releaseRoot,
      links: { claude: claudeLink, codex: codexLink },
    }),
    (error) => error.code === 'LINK_TARGET_EXISTS' && error.link === 'claude',
  );
  assert.equal(await readFile(join(claudeLink, 'keep.txt'), 'utf8'), 'recover me\n');

  const backupRoot = join(root, 'backups');
  const installed = await installRelease({
    repo, ref: oldCommit, profile, releaseRoot,
    links: { claude: claudeLink, codex: codexLink }, backupRoot,
  });
  assert.equal(installed.backups.length, 1);
  assert.equal(await readFile(join(installed.backups[0].backup, 'keep.txt'), 'utf8'), 'recover me\n');
  assert.equal(await realpath(claudeLink), await realpath(codexLink));
});

test('rejects a backup root that overlaps the immutable release root before materializing', async (t) => {
  const { root, repo, oldCommit } = await createSourceRepository(t);
  const profile = join(root, 'private-profile.md');
  const releaseRoot = join(root, 'releases');
  await writeFile(profile, '# private project anchors\n');
  await mkdir(join(root, 'claude-skill'));

  await assert.rejects(
    installRelease({
      repo, ref: oldCommit, profile, releaseRoot,
      links: { claude: join(root, 'claude-skill'), codex: join(root, 'codex-skill') },
      backupRoot: releaseRoot,
    }),
    (error) => error.code === 'BACKUP_PATH_INVALID',
  );
  await assert.rejects(lstat(join(releaseRoot, oldCommit)), { code: 'ENOENT' });
});

test('does not switch an earlier runtime link when staging a later link fails', async (t) => {
  const { root, repo, oldCommit } = await createSourceRepository(t);
  const profile = join(root, 'private-profile.md');
  const lockedParent = join(root, 'locked');
  const claudeLink = join(root, 'claude-skill');
  const codexLink = join(lockedParent, 'codex-skill');
  await writeFile(profile, '# private project anchors\n');
  await mkdir(lockedParent);
  await chmod(lockedParent, 0o500);
  t.after(async () => {
    try {
      await chmod(lockedParent, 0o700);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  });

  await assert.rejects(
    installRelease({
      repo, ref: oldCommit, profile, releaseRoot: join(root, 'releases'),
      links: { claude: claudeLink, codex: codexLink },
    }),
    (error) => error.code === 'LINK_LOCK_UNAVAILABLE',
  );
  await assert.rejects(lstat(claudeLink), { code: 'ENOENT' });
});

test('rejects lexical and symlink-alias link overlap with source and private profile before mutation', async (t) => {
  const { root, repo, oldCommit } = await createSourceRepository(t);
  const profile = join(root, 'private-profile.md');
  const backupRoot = join(root, 'backups');
  const alias = join(root, 'alias');
  await writeFile(profile, '# private project anchors\n');
  await symlink(root, alias, 'dir');

  for (const target of [repo, profile, join(alias, 'source')]) {
    await assert.rejects(
      installRelease({
        repo, ref: oldCommit, profile, releaseRoot: join(root, 'releases'), backupRoot,
        links: { claude: target, codex: join(root, 'codex-skill') },
      }),
      (error) => error.code === 'PATH_PROTECTED_OVERLAP',
    );
  }
  assert.equal(await readFile(profile, 'utf8'), '# private project anchors\n');
  assert.match((await git(repo, ['rev-parse', 'HEAD'])).stdout.trim(), /^[0-9a-f]{40}$/);
});

test('rejects nested and duplicate runtime link topology before release mutation', async (t) => {
  const { root, repo, oldCommit } = await createSourceRepository(t);
  const profile = join(root, 'private-profile.md');
  const linkRoot = join(root, 'runtime-skill');
  await writeFile(profile, '# private project anchors\n');

  await assert.rejects(
    installRelease({
      repo, ref: oldCommit, profile, releaseRoot: join(root, 'releases'),
      links: { claude: linkRoot, codex: join(linkRoot, 'nested') },
    }),
    (error) => error.code === 'LINK_TARGET_TOPOLOGY_INVALID',
  );
  await assert.rejects(lstat(join(root, 'releases', oldCommit)), { code: 'ENOENT' });
});

test('rejects release and backup paths nested under source or profile', async (t) => {
  const { root, repo, oldCommit } = await createSourceRepository(t);
  const profile = join(root, 'private-profile.md');
  await writeFile(profile, '# private project anchors\n');
  const links = { claude: join(root, 'claude-skill'), codex: join(root, 'codex-skill') };

  await assert.rejects(
    installRelease({ repo, ref: oldCommit, profile, releaseRoot: join(repo, 'releases'), links }),
    (error) => error.code === 'PATH_PROTECTED_OVERLAP',
  );
  await assert.rejects(
    installRelease({
      repo, ref: oldCommit, profile, releaseRoot: join(root, 'releases'),
      backupRoot: join(profile, 'backups'), links,
    }),
    (error) => error.code === 'PATH_PROTECTED_OVERLAP',
  );
});

test('rejects duplicate runtime link targets before release mutation', async (t) => {
  const { root, repo, oldCommit } = await createSourceRepository(t);
  const profile = join(root, 'private-profile.md');
  const target = join(root, 'runtime-skill');
  await writeFile(profile, '# private project anchors\n');

  await assert.rejects(
    installRelease({
      repo, ref: oldCommit, profile, releaseRoot: join(root, 'releases'),
      links: { claude: target, codex: target },
    }),
    (error) => error.code === 'LINK_TARGET_TOPOLOGY_INVALID',
  );
});

test('rolls back a completed backup switch when a later backup collision fails', async (t) => {
  const { root, repo, oldCommit } = await createSourceRepository(t);
  const profile = join(root, 'private-profile.md');
  const backupRoot = join(root, 'backups');
  const claudeLink = join(root, 'claude-skill');
  const codexLink = join(root, 'codex-skill');
  await writeFile(profile, '# private project anchors\n');
  await mkdir(claudeLink);
  await writeFile(join(claudeLink, 'restore.txt'), 'original claude\n');
  await mkdir(codexLink);
  await writeFile(join(codexLink, 'restore.txt'), 'original codex\n');
  await mkdir(backupRoot, { recursive: true });
  await mkdir(join(backupRoot, `codex-${process.pid}-1`));

  await assert.rejects(
    installRelease({
      repo, ref: oldCommit, profile, releaseRoot: join(root, 'releases'), backupRoot,
      links: { claude: claudeLink, codex: codexLink },
    }),
    (error) => error.code === 'BACKUP_TARGET_EXISTS'
      && error.backups?.length === 1
      && error.backups[0].link === 'claude',
  );
  assert.equal(await readFile(join(claudeLink, 'restore.txt'), 'utf8'), 'original claude\n');
  assert.equal(await readFile(join(codexLink, 'restore.txt'), 'utf8'), 'original codex\n');
});

test('verifyRelease reports unexpected empty directories as release drift', async (t) => {
  const { root, repo, oldCommit } = await createSourceRepository(t);
  const profile = join(root, 'private-profile.md');
  await writeFile(profile, '# private project anchors\n');
  const { releaseDir, manifestDigest } = await installRelease({
    repo, ref: oldCommit, profile, releaseRoot: join(root, 'releases'),
    links: { claude: join(root, 'claude-skill'), codex: join(root, 'codex-skill') },
  });
  await mkdir(join(releaseDir, 'unexpected-empty'));

  const verification = await verifyRelease(releaseDir, { expectedManifestDigest: manifestDigest });
  assert.equal(verification.ok, false);
  assert.ok(verification.drift.some((entry) => entry.code === 'UNEXPECTED_RELEASE_DIRECTORY'
    && entry.path === 'unexpected-empty'));
});

test('verifyRelease reports an unexpected symlink directory as release drift', async (t) => {
  const { root, repo, oldCommit } = await createSourceRepository(t);
  const profile = join(root, 'private-profile.md');
  await writeFile(profile, '# private project anchors\n');
  const { releaseDir, manifestDigest } = await installRelease({
    repo, ref: oldCommit, profile, releaseRoot: join(root, 'releases'),
    links: { claude: join(root, 'claude-skill'), codex: join(root, 'codex-skill') },
  });
  const outside = join(root, 'outside-directory');
  await mkdir(outside);
  await symlink(outside, join(releaseDir, 'unexpected-link'), 'dir');

  const verification = await verifyRelease(releaseDir, { expectedManifestDigest: manifestDigest });
  assert.equal(verification.ok, false);
  assert.ok(verification.drift.some((entry) => entry.code === 'UNEXPECTED_RELEASE_FILE'
    && entry.path === 'unexpected-link'));
});

test('re-verifies the external manifest digest before switching runtime links', async (t) => {
  const { root, repo, oldCommit } = await createSourceRepository(t);
  const profile = join(root, 'private-profile.md');
  const releaseRoot = join(root, 'releases');
  const claudeLink = join(root, 'claude-skill');
  const codexLink = join(root, 'codex-skill');
  await writeFile(profile, '# private project anchors\n');

  await assert.rejects(
    installRelease({
      repo, ref: oldCommit, profile, releaseRoot,
      links: { claude: claudeLink, codex: codexLink },
    }, {
      faultInjector: async (phase) => {
        if (phase !== 'after_release') return;
        const releaseDir = join(releaseRoot, oldCommit);
        const tampered = Buffer.from('# substituted after materialization\n');
        await writeFile(join(releaseDir, 'SKILL.md'), tampered);
        const manifestPath = join(releaseDir, 'manifest.json');
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        manifest.source_files.find((entry) => entry.path === 'SKILL.md').sha256 = createHash('sha256').update(tampered).digest('hex');
        await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      },
    }),
    (error) => error.code === 'RELEASE_DRIFT',
  );

  await assert.rejects(lstat(claudeLink), { code: 'ENOENT' });
  await assert.rejects(lstat(codexLink), { code: 'ENOENT' });
});

test('competing child installs serialize shared links without erasing a successful release', async (t) => {
  const { root, repo, oldCommit, newCommit } = await createSourceRepository(t);
  const profile = join(root, 'private-profile.md');
  const releaseRoot = join(root, 'releases');
  const claudeLink = join(root, 'claude-skill');
  const codexLink = join(root, 'codex-skill');
  await writeFile(profile, '# private project anchors\n');
  const installArgs = (ref) => [
    'goal-condition-template/scripts/install.mjs', 'install',
    '--repo', repo, '--ref', ref, '--profile', profile, '--release-root', releaseRoot,
    '--link', `claude=${claudeLink}`, '--link', `codex=${codexLink}`,
  ];

  const [first, second] = await Promise.all([
    execFile(process.execPath, installArgs(oldCommit), { cwd: process.cwd(), encoding: 'utf8' }),
    execFile(process.execPath, installArgs(newCommit), { cwd: process.cwd(), encoding: 'utf8' }),
  ]);
  assert.match(first.stdout, /^INSTALLED commit=/);
  assert.match(second.stdout, /^INSTALLED commit=/);
  assert.equal(await realpath(claudeLink), await realpath(codexLink));
  const finalRelease = await realpath(claudeLink);
  assert.ok((await Promise.all([oldCommit, newCommit].map((commit) => realpath(join(releaseRoot, commit))))).includes(finalRelease));
  const oldManifest = JSON.parse(await readFile(join(releaseRoot, oldCommit, 'manifest.json'), 'utf8'));
  const newManifest = JSON.parse(await readFile(join(releaseRoot, newCommit, 'manifest.json'), 'utf8'));
  const manifestDigest = (manifest) => createHash('sha256').update(`${JSON.stringify(manifest, null, 2)}\n`).digest('hex');
  assert.equal((await verifyRelease(join(releaseRoot, oldCommit), {
    expectedManifestDigest: manifestDigest(oldManifest),
  })).ok, true);
  assert.equal((await verifyRelease(join(releaseRoot, newCommit), {
    expectedManifestDigest: manifestDigest(newManifest),
  })).ok, true);
});

test('cleans an owned empty lock when owner metadata cannot be written', async (t) => {
  const { root, repo, oldCommit } = await createSourceRepository(t);
  const profile = join(root, 'private-profile.md');
  const options = {
    repo, ref: oldCommit, profile, releaseRoot: join(root, 'releases'),
    links: { claude: join(root, 'claude-skill'), codex: join(root, 'codex-skill') },
  };
  await writeFile(profile, '# private project anchors\n');
  const originalUmask = process.umask(0o777);
  try {
    await assert.rejects(installRelease(options), (error) => error.code === 'LINK_LOCK_UNAVAILABLE');
  } finally {
    process.umask(originalUmask);
  }
  const installed = await installRelease(options);
  assert.equal(installed.commit, oldCommit);
});

test('fails closed when a link-parent ancestor is repointed after locks are acquired', async (t) => {
  const { root, repo, oldCommit } = await createSourceRepository(t);
  const profile = join(root, 'private-profile.md');
  const linkParent = join(root, 'runtime-links');
  const displacedParent = join(root, 'runtime-links-displaced');
  const releaseRoot = join(root, 'releases');
  const backupRoot = join(root, 'backups');
  await writeFile(profile, '# private project anchors\n');
  await mkdir(linkParent);
  const sourceHeadBeforeRace = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
  t.after(async () => {
    await rm(linkParent, { recursive: true, force: true });
    await rm(displacedParent, { recursive: true, force: true });
  });

  await assert.rejects(
    installRelease({
      repo, ref: oldCommit, profile, releaseRoot, backupRoot,
      links: {
        claude: join(linkParent, 'claude-skill'),
        codex: join(linkParent, 'codex-skill'),
      },
    }, {
      faultInjector: async (phase) => {
        if (phase !== 'after_locks') return;
        await rename(linkParent, displacedParent);
        await symlink(repo, linkParent, 'dir');
      },
    }),
    (error) => error.code === 'LINK_PARENT_IDENTITY_CHANGED',
  );

  for (const name of ['claude-skill', 'codex-skill']) {
    await assert.rejects(lstat(join(repo, name)), { code: 'ENOENT' });
  }
  assert.equal(await readFile(profile, 'utf8'), '# private project anchors\n');
  assert.equal((await git(repo, ['rev-parse', 'HEAD'])).stdout.trim(), sourceHeadBeforeRace);
  await assert.rejects(lstat(join(releaseRoot, oldCommit)), { code: 'ENOENT' });
  await assert.rejects(lstat(backupRoot), { code: 'ENOENT' });
});

test('fails closed when the release-root ancestor is repointed after locks are acquired', async (t) => {
  const { root, repo, oldCommit } = await createSourceRepository(t);
  const profile = join(root, 'private-profile.md');
  const releaseParent = join(root, 'release-parent');
  const displacedParent = join(root, 'release-parent-displaced');
  const releaseRoot = join(releaseParent, 'releases');
  await writeFile(profile, '# private project anchors\n');
  await mkdir(releaseParent);
  t.after(async () => {
    await rm(releaseParent, { recursive: true, force: true });
    await rm(displacedParent, { recursive: true, force: true });
  });

  await assert.rejects(
    installRelease({
      repo, ref: oldCommit, profile, releaseRoot,
      links: { claude: join(root, 'claude-skill'), codex: join(root, 'codex-skill') },
    }, {
      faultInjector: async (phase) => {
        if (phase !== 'after_locks') return;
        await rename(releaseParent, displacedParent);
        await symlink(repo, releaseParent, 'dir');
      },
    }),
    (error) => error.code === 'RELEASE_ROOT_IDENTITY_CHANGED',
  );

  await assert.rejects(lstat(join(repo, 'releases')), { code: 'ENOENT' });
  await assert.rejects(lstat(join(displacedParent, 'releases')), { code: 'ENOENT' });
  await assert.rejects(lstat(join(root, 'claude-skill')), { code: 'ENOENT' });
  await assert.rejects(lstat(join(root, 'codex-skill')), { code: 'ENOENT' });
});

test('fails closed when the backup-root ancestor is repointed after locks are acquired', async (t) => {
  const { root, repo, oldCommit } = await createSourceRepository(t);
  const profile = join(root, 'private-profile.md');
  const backupParent = join(root, 'backup-parent');
  const displacedParent = join(root, 'backup-parent-displaced');
  const backupRoot = join(backupParent, 'backups');
  await writeFile(profile, '# private project anchors\n');
  await mkdir(backupParent);
  await mkdir(join(root, 'claude-skill'));
  await writeFile(join(root, 'claude-skill', 'keep.txt'), 'recover me\n');
  t.after(async () => {
    await rm(backupParent, { recursive: true, force: true });
    await rm(displacedParent, { recursive: true, force: true });
  });

  await assert.rejects(
    installRelease({
      repo, ref: oldCommit, profile, releaseRoot: join(root, 'releases'), backupRoot,
      links: { claude: join(root, 'claude-skill'), codex: join(root, 'codex-skill') },
    }, {
      faultInjector: async (phase) => {
        if (phase !== 'after_locks') return;
        await rename(backupParent, displacedParent);
        await symlink(repo, backupParent, 'dir');
      },
    }),
    (error) => error.code === 'BACKUP_ROOT_IDENTITY_CHANGED',
  );

  assert.equal(await readFile(join(root, 'claude-skill', 'keep.txt'), 'utf8'), 'recover me\n');
  await assert.rejects(lstat(join(repo, 'backups')), { code: 'ENOENT' });
  await assert.rejects(lstat(join(root, 'releases', oldCommit)), { code: 'ENOENT' });
});
