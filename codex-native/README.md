# Codex native Goal workflow

For new Codex goals, `goal-condition` defines the outcome and verification and uses native `/goal` for execution. `boundary-design` prepares a portable brief. No custom project registration, admission receipt, authorization hash, controller, or mandatory commit is needed.

Plan-only requests stay plan-only. Explicitly requested execution uses a native goal tool when available; an existing native goal is reused. If the host has no native interface, the skill supplies text for the user to enter with `/goal` and does not simulate a runtime. The skill does not change host permissions or waive project approvals.

## Install or update Codex only

Requires Node.js 24.15 or later for the optional legacy SQLite inventory. From the repository root:

```sh
node codex-native/scripts/install.mjs inspect
node codex-native/scripts/install.mjs install
node codex-native/scripts/install.mjs status
```

Commands honor `CODEX_HOME`, otherwise use `~/.codex`. Tests and alternate installations use `--codex-home PATH`. Installation is an explicit configuration mutation; run it only when authorized. The installer accepts empty destinations, its own intact native installation, or the exact old global-wrapper skill links. Unowned entries and edited installed skills are preserved and reported for review.

The two skills are installed as physical directories. Previous entries and installation receipts live under the Codex adaptations directory. Old generations, controller state, project registrations, and `.env` files are untouched. Old wrapper activation that expects its own symlinks rejects these new directories rather than replacing them; do not force an old installer over the native installation. Use `status` after updates to detect entry drift.

`inspect` reads status counts and runtime marker names, not goal prompts or raw logs. It also checks for matching legacy processes. A blocking or unreadable inventory requires investigation through the old supported recovery path. The inventory is a point-in-time migration check, not a sandbox or proof against concurrently starting an old process. Do not run old launchers during the switch.

RPC logs remain after the legacy close routine and are counted as historical artifacts. Their presence alone does not block installation; live pointers, leases, unfinished launch intents, active sessions, and matching processes still do.

## Roll back

Pause or stop any overlapping native work first, then:

```sh
node codex-native/scripts/install.mjs rollback
```

Rollback checks current installed bytes and backups before changing entries. It refuses drift, retains legacy state, and restores a previous native release or the old links. A crash leaving an installation lock needs explicit recovery after verifying the installer process has exited; the installer does not guess that a lock is stale. Preserve the receipt and backup if recovery fails.

## Verification

```sh
npm run test:native
```

The executable tests exercise installation, rollback, drift detection, metadata-only migration inventory, and evidence assessment. They do not prove that a language model follows every instruction or independently certify an execution. [Behavior scenarios](tests/behavior-scenarios.md) specify forward checks for a real host. Run native smoke checks only as part of authorized work; do not launch paid services or extra agents to validate the skill.

See the [validation record](VALIDATION.md) for observed results and remaining evaluation coverage.

## Legacy and Claude compatibility

The existing `goal-condition-template/` controllers and Claude runtime implementation are retained for historical recovery and separate Claude maintenance. They are not a fallback for new Codex goals. A project-specific certification requirement must be resolved through that project's governance; native Goal completion does not satisfy it by renaming the result.

Local project profiles should retain their evidence and authority rules while routing new Codex work through this skill. See [migration](skills/goal-condition/references/legacy-migration.md) and the [Claude handoff](../docs/handoffs/2026-09-09-codex-native-goal.md). Private profiles, machine paths, receipts and migration identifiers must not be committed to the public repository.
