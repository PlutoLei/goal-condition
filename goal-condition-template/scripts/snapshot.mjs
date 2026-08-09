import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  captureSnapshot, compareSnapshot, snapshotDiagnostics, snapshotDigest, SnapshotError,
} from './lib/snapshot.mjs';
import { readContract, validateContract } from './lib/contract.mjs';

function usage() {
  return [
    'Usage:',
    '  node scripts/snapshot.mjs capture --contract CONTRACT --out BASELINE',
    '  node scripts/snapshot.mjs verify --contract CONTRACT --baseline BASELINE --expected-baseline-digest DIGEST',
  ].join('\n');
}

function diagnosticLine(diagnostic) {
  return `${diagnostic.code} entry=${diagnostic.entry ?? 'contract'} field=${diagnostic.field ?? diagnostic.path ?? 'unknown'} observed=${diagnostic.observed} expected=${diagnostic.expected} next=${diagnostic.next}`;
}

function argumentError(code, field, observed, expected, next) {
  return new Error(`${diagnosticLine({ code, entry: 'baseline', field, observed, expected, next })}\n${usage()}`);
}

function parseArguments(argv) {
  if (argv.length === 1 && argv[0] === '--help') return { help: true };
  const [command, ...rest] = argv;
  if (!['capture', 'verify'].includes(command)) throw new Error(usage());
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!['--contract', '--out', '--baseline', '--expected-baseline-digest'].includes(flag) || value === undefined || values[flag] !== undefined) {
      throw new Error(usage());
    }
    values[flag] = value;
  }
  if (!values['--contract']) throw new Error(usage());
  if (command === 'capture' && (!values['--out'] || values['--baseline'] || values['--expected-baseline-digest'])) throw new Error(usage());
  if (command === 'verify' && (!values['--baseline'] || values['--out'])) throw new Error(usage());
  if (command === 'verify' && values['--expected-baseline-digest'] === undefined) {
    throw argumentError(
      'EXPECTED_BASELINE_DIGEST_REQUIRED', '--expected-baseline-digest', 'missing', 'trusted external SHA-256 baseline digest',
      'persist the digest printed by capture in confirmed orchestration state and supply it to verify',
    );
  }
  if (command === 'verify' && !/^[0-9a-f]{64}$/.test(values['--expected-baseline-digest'])) {
    throw argumentError(
      'EXPECTED_BASELINE_DIGEST_INVALID', '--expected-baseline-digest', 'invalid digest format', 'lowercase 64-character SHA-256 hex',
      'supply the unmodified digest printed by capture from trusted orchestration state',
    );
  }
  return {
    command,
    contract: values['--contract'],
    out: values['--out'],
    baseline: values['--baseline'],
    expectedBaselineDigest: values['--expected-baseline-digest'],
  };
}

async function writeSnapshotAtomically(output, snapshot) {
  const destination = resolve(output);
  const temporary = resolve(dirname(destination), `.${process.pid}.snapshot-writing`);
  try {
    await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function run() {
  let parsed;
  try {
    parsed = parseArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  if (parsed.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  let contract;
  try {
    contract = await readContract(parsed.contract);
  } catch (error) {
    process.stderr.write('CONTRACT_READ_FAILED entry=contract field=--contract observed=unreadable_input expected=readable canonical JSON contract next=correct the contract path or JSON syntax\n');
    process.exitCode = 1;
    return;
  }
  const validation = validateContract(contract);
  if (validation.length) {
    validation.forEach((item) => process.stderr.write(diagnosticLine(item) + '\n'));
    process.exitCode = 1;
    return;
  }

  try {
    if (parsed.command === 'capture') {
      const snapshot = await captureSnapshot(contract, { phase: 'capture' });
      await writeSnapshotAtomically(parsed.out, snapshot);
      process.stdout.write(`CAPTURED snapshot sha256=${snapshot.contract_hash} baseline_digest=${snapshotDigest(snapshot)}\n`);
      return;
    }
    const baseline = JSON.parse(await readFile(parsed.baseline, 'utf8'));
    const baselineDiagnostics = snapshotDiagnostics(contract, baseline);
    if (baselineDiagnostics.length) throw new SnapshotError(baselineDiagnostics);
    const actualBaselineDigest = snapshotDigest(baseline);
    if (actualBaselineDigest !== parsed.expectedBaselineDigest) {
      throw new SnapshotError([{
        code: 'BASELINE_DIGEST_MISMATCH',
        entry: 'baseline',
        field: 'expected-baseline-digest',
        observed: actualBaselineDigest,
        expected: parsed.expectedBaselineDigest,
        next: 'recover the original baseline referenced by trusted orchestration state',
      }]);
    }
    const baselineGitHeads = Object.fromEntries(baseline.entries
      .filter((entry) => entry.type === 'git')
      .map((entry) => [entry.id, entry.head]));
    const current = await captureSnapshot(contract, { baselineGitHeads, phase: 'verify' });
    const result = compareSnapshot(contract, baseline, current, {
      expectedBaselineDigest: parsed.expectedBaselineDigest,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    if (error instanceof SnapshotError) {
      error.diagnostics.forEach((item) => process.stderr.write(diagnosticLine(item) + '\n'));
    } else {
      process.stderr.write(`SNAPSHOT_FAILED entry=snapshot field=operation observed=${error.code ?? error.name} expected=successful snapshot operation next=inspect the contract and snapshot inputs\n`);
    }
    process.exitCode = 1;
  }
}

await run();
