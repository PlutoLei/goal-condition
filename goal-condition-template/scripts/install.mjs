import { installRelease, verifyRelease } from './lib/installer.mjs';

function usage() {
  return [
    'Usage:',
    '  node scripts/install.mjs install --repo PATH --ref REF --profile FILE --release-root PATH --link NAME=PATH [--link NAME=PATH ...] [--backup-root PATH]',
    '  node scripts/install.mjs verify --release PATH --expected-manifest-digest DIGEST',
  ].join('\n');
}

function parseLinks(values) {
  const links = {};
  for (const value of values) {
    const separator = value.indexOf('=');
    const name = value.slice(0, separator);
    const target = value.slice(separator + 1);
    if (separator <= 0 || !/^[A-Za-z0-9_-]+$/.test(name) || target.length === 0 || links[name] !== undefined) {
      throw new Error(usage());
    }
    links[name] = target;
  }
  return links;
}

function parseArguments(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true };
  const [command, ...rest] = argv;
  if (!['install', 'verify'].includes(command)) throw new Error(usage());
  const values = {};
  const links = [];
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (value === undefined) throw new Error(usage());
    if (flag === '--link') {
      links.push(value);
      continue;
    }
    if (!['--repo', '--ref', '--profile', '--release-root', '--backup-root', '--release', '--expected-manifest-digest'].includes(flag) || values[flag] !== undefined) {
      throw new Error(usage());
    }
    values[flag] = value;
  }
  if (command === 'verify') {
    if (!values['--release'] || !/^[0-9a-f]{64}$/.test(values['--expected-manifest-digest'] ?? '')
      || Object.keys(values).length !== 2 || links.length > 0) throw new Error(usage());
    return {
      command,
      release: values['--release'],
      expectedManifestDigest: values['--expected-manifest-digest'],
    };
  }
  const required = ['--repo', '--ref', '--profile', '--release-root'];
  if (required.some((flag) => !values[flag]) || links.length === 0
    || values['--release'] || values['--expected-manifest-digest']) throw new Error(usage());
  return {
    command,
    repo: values['--repo'],
    ref: values['--ref'],
    profile: values['--profile'],
    releaseRoot: values['--release-root'],
    links: parseLinks(links),
    backupRoot: values['--backup-root'],
  };
}

async function run() {
  let parsed;
  try {
    parsed = parseArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  if (parsed.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  try {
    if (parsed.command === 'verify') {
      const result = await verifyRelease(parsed.release, {
        expectedManifestDigest: parsed.expectedManifestDigest,
      });
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (!result.ok) process.exitCode = 1;
      return;
    }
    const result = await installRelease(parsed);
    process.stdout.write(`INSTALLED commit=${result.commit} manifestDigest=${result.manifestDigest}\n`);
  } catch (error) {
    process.stderr.write(`${error.code ?? 'INSTALL_FAILED'} observed=operation_failed next=inspect the commit, profile, release, and link inputs\n`);
    process.exitCode = 1;
  }
}

await run();
