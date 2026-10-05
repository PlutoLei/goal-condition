# Legacy records and migration

New Codex goals use native Goal mode. Old controllers, generations, receipts, and registries remain evidence and recovery dependencies for existing sessions only. Do not edit their databases, leases, admission receipts, or active generation links by hand.

Before migrating an old session, inspect its saved status, launch intent, lease, and relevant native process state. A missing lease alone does not establish quiescence. Use the old deployment's supported readback/reconcile/close commands for a previously launched session; never issue a new legacy launch to migrate it. If a record is uncertain, stop dependent migration and report the missing evidence.

| Old state | Migration |
|---|---|
| Draft or awaiting confirmation, never launched | Carry forward outcome, useful scope and criteria; record that the old draft was not adopted. Do not confirm its hash or consume its admission. |
| Unfinished but quiescent | Preserve artifacts and checks, identify remaining work, and explicitly map it to a native task. Do not replay completed effects. |
| Active or uncertain | Reconcile or close through the old tool before starting overlapping work. |
| Complete with evidence | Preserve original result and provenance. Never relabel it as a new native run. |

A migration note needs the old identifier, destination task, artifacts/evidence retained, remaining work, and unresolved gates. It is an external note, not a forged status update. Existing legacy approvals do not expand new task authority.

The Codex installer keeps copies of replaced skill entries and an installation receipt outside the legacy store. `status` detects drift; `rollback` refuses to overwrite edited installed skills. Do not use install rollback to cancel native work: first pause/stop overlapping work using host controls. Legacy code that requires ownership of its old skill symlinks should reject the new physical directories; do not force it to overwrite them.

For projects whose authoritative rules still demand a controller-certified execution, obtain the appropriate rule change or keep that work pending. Native completion is not a substitute for the old certification requirement.
