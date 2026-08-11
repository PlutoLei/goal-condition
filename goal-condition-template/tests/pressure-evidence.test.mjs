import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const evidenceUrl = new URL('../evidence/pressure-evidence.json', import.meta.url);
const codexV2EvidenceUrl = new URL(
  '../evidence/codex-goal-session-v2-pressure-evidence.json',
  import.meta.url,
);

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

test('public pressure evidence contains five genuine paired text-only samples', async () => {
  const evidence = JSON.parse(await readFile(evidenceUrl, 'utf8'));
  assert.equal(evidence.schema_version, 1);
  assert.equal(evidence.protocol.fresh_session_per_sample, true);
  assert.equal(evidence.protocol.paired_prompt_identical, true);
  assert.match(evidence.protocol.only_variant_difference, /skill_instructions\.text/);
  assert.equal(evidence.protocol.no_tools, true);
  assert.equal(evidence.protocol.no_private_context, true);
  assert.match(evidence.protocol.limitation, /model sample evidence.*not deterministic unit proof/i);
  assert.match(evidence.skill_instructions.sha256, /^[0-9a-f]{64}$/);
  assert.equal(digest(evidence.skill_instructions.text), evidence.skill_instructions.sha256);

  const expectedScenarios = [
    'prompt-injection',
    'multi-goal-pressure',
    'fake-physical-mechanism',
    'temporary-context',
    'false-completion-pressure',
  ];
  assert.deepEqual(evidence.scenarios.map((item) => item.id).sort(), expectedScenarios.sort());
  for (const scenario of evidence.scenarios) {
    assert.equal(typeof scenario.prompt, 'string');
    assert.ok(scenario.prompt.length > 0);
    assert.deepEqual(scenario.samples.map((sample) => sample.variant).sort(), ['no-skill', 'with-skill']);
    for (const sample of scenario.samples) {
      assert.equal(sample.scenario_prompt_sha256, digest(scenario.prompt));
      assert.equal(typeof sample.output, 'string');
      assert.ok(sample.output.length > 0);
      assert.equal(sample.tools_used, false);
      assert.equal(sample.private_context_used, false);
      assert.equal(
        sample.skill_instructions_sha256,
        sample.variant === 'with-skill' ? evidence.skill_instructions.sha256 : null,
      );
    }
  }
});

test('Codex GoalSession v2 pressure evidence preserves RED and requires paired GREEN samples', async () => {
  const evidence = JSON.parse(await readFile(codexV2EvidenceUrl, 'utf8'));
  assert.equal(evidence.schema_version, 1);
  assert.ok(['red_captured', 'green_verified'].includes(evidence.campaign_status));
  assert.equal(evidence.protocol.fresh_context_per_sample, true);
  assert.match(evidence.protocol.limitation, /observational.*not deterministic proof/i);

  const expectedScenarios = [
    'repeated-contract-pressure',
    'false-green-pressure',
    'grill-confusion',
  ];
  assert.deepEqual(evidence.scenarios.map((item) => item.id).sort(), expectedScenarios.sort());

  const groups = [...evidence.scenarios, ...evidence.controls];
  for (const group of groups) {
    assert.equal(typeof group.prompt, 'string');
    assert.ok(group.prompt.length > 0);
    if (group.prompt_redacted === true) {
      assert.equal(group.prompt_template_sha256, digest(group.prompt));
      assert.match(group.actual_prompt_sha256, /^[0-9a-f]{64}$/);
    }
    for (const sample of group.samples) {
      assert.equal(
        sample.prompt_sha256,
        group.prompt_redacted === true ? group.actual_prompt_sha256 : digest(group.prompt),
      );
      assert.ok(['no-v2-guidance', 'with-v2-guidance'].includes(sample.variant));
      assert.ok(['PASS', 'FAIL'].includes(sample.verdict));
      assert.equal(typeof sample.output, 'string');
      assert.ok(sample.output.length > 0);
      assert.equal(typeof sample.tools_used, 'boolean');
      assert.equal(typeof sample.private_context_used, 'boolean');
      assert.equal(typeof sample.limitation, 'string');
      assert.ok(sample.limitation.length > 0);
    }
  }

  const repeated = evidence.scenarios.find((item) => item.id === 'repeated-contract-pressure');
  assert.ok(
    repeated.samples.filter((sample) => sample.variant === 'no-v2-guidance').length >= 5,
    'S1 needs at least five independently judged no-guidance controls',
  );

  const allSamples = groups.flatMap((group) => group.samples);
  assert.ok(
    allSamples.some((sample) => sample.variant === 'no-v2-guidance' && sample.verdict === 'FAIL'),
    'the baseline campaign must preserve a genuine RED sample',
  );

  if (evidence.campaign_status === 'green_verified') {
    for (const group of groups) {
      const variants = new Set(group.samples.map((sample) => sample.variant));
      assert.equal(variants.has('no-v2-guidance'), true);
      assert.equal(variants.has('with-v2-guidance'), true);
      assert.equal(
        group.samples
          .filter((sample) => sample.variant === 'with-v2-guidance')
          .every((sample) => sample.verdict === 'PASS'),
        true,
      );
    }
    assert.ok(
      repeated.samples.filter((sample) => sample.variant === 'with-v2-guidance').length >= 5,
      'S1 needs at least five independently judged with-guidance controls',
    );
  }
});
