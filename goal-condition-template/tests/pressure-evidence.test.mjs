import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const evidenceUrl = new URL('../evidence/pressure-evidence.json', import.meta.url);

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
