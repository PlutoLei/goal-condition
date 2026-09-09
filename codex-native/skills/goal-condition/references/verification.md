# Verification without a second controller

Choose checks proportional to the change. A documentation change may need link and consistency checks; a provider change needs request-contract, integration, failure, and regression tests. A research result needs its protocol, actual run evidence, and applicable independent review.

A useful evidence row contains:

| Field | Meaning |
|---|---|
| Criterion | Observable requirement being assessed |
| Status | passed, failed, not-run, or not-applicable |
| Source | Actual artifact, command output, measurement, or review |
| Scope | What the evidence establishes and does not establish |
| Freshness | Whether relevant inputs changed after capture |

Use a structured file only when it helps reproducible evaluation. The optional `scripts/check-evidence.mjs` accepts a JSON report with `criteria`, `evidence`, and `remaining_work`. It checks declared coverage, scope, and stale/failed evidence; it does not run tests, authenticate the evidence, or update a native goal. Its `requirements_met` result is an assessment of the supplied report, not independent runtime certification.

Each criterion has `id`, `required`, `required_level` (`mock`, `local`, `external`, or `independent`), and `status`. Required criteria must pass. Each evidence item has a unique `id`, `criterion_id`, `level`, `passed`, `current`, and a nonempty `source`. Levels must match the criterion exactly; a reviewer label does not turn a local test into an external experiment. Each submitted evidence item must be current and passing; archive superseded evidence separately. A real external-result criterion uses `external`; its separate required review criterion uses `independent`.

Do not change requiredness or level to make a report pass. Changes to acceptance semantics need the applicable user/project decision. Keep optional failures and exclusions visible. `remaining_work` contains outstanding tasks, not a lifecycle status.

For output delivery, separate completed artifacts, checked behavior, unverified claims, and remaining gates. Publication, real API quality, GPU runs, and scientific acceptance cannot be inferred from local unit tests.
