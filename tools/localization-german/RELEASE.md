# German release preparation

Historical source-specific root and hardware IFC/WASM workflow evidence is in
REPORT.md and WORKFLOW.md. Original campaigns and foreign jobs were read only;
none are copied into this release. Bulk audit inventories, per-file hash lists
and translation-shard inputs are excluded: runtime object contracts provide the
maintained coverage guard; exact-value identical-word allowances remain.

Integration adds 15 current-main keys and updated measurement/capture guidance.
Each shipping locale owns all 10,622 current English keys; bounded loaded-object
audit found no missing/unknown keys or stale identical-word exceptions.
Shared test-only coverage/plural/startup helpers remove repeated contracts.
German browser acceptance now requires the exact ten unique all-pass checks,
rejects inspection and every page error, including fresh negotiation.
Final-head root typecheck, selected i18n tests, lint, pre-handoff and full viewer
integration are separate required checks; historical receipts do not certify them.

Proposed stack: German plus shared infrastructure, French, Italian. Keep all
layers draft until pending acceptance is reconciled; no deployment or merge label
is applied by release preparation. Preview query: `?lang=de`; English: `?lang=en`.
Rollback uses a normal commit per the i18n README; nightly production advances
from main at 05:45 UTC, so incomplete locales must not enter the merge queue.

## Shared contract type correction

Pop selected-root request `auto-0e48aa47e939438d873cff447b1019e2` on
`03e04c4997` passed selected tests and all 13 pre-handoff rows; root typecheck
failed TS7022/TS7006 for the shared plural helper's inferred placeholder-name
list, and lint stopped at standalone viewer compilation. The root typecheck tail
did not run. Add an explicit `string[]` annotation to that list; this changes no
assertions or runtime behavior. Fresh committed root validation is required.
The original final-head request `auto-79a6e675865042a0bc8ad79a58a745ce` remains
owned by its original source and worker; do not replay it.
