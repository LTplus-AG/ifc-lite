# STEP writer guards (#7682, PR #7715)

`appended-record-guards.oracle.patch` is the revert-oracle mutation for the STEP-writer guards of #7682. The step that applies it is "Prove the changed tests observe the production change" in `.github/workflows/test.yml`.

The PR adds modules (`step_ids.rs`, `step_index.rs`), `StepStats` fields and a TS export (`allocatedExpressId`) that its tests use. A whole-change revert deletes all of them, so the reverted tests never load and the oracle reports REVERT-BROKE-BUILD. This patch keeps every new item and disables ONLY the behaviour each test pins:

| finding | guard disabled | Rust | TypeScript |
|---|---|---|---|
| EXPORT-STEP-26 | caller-value check | `is_step_value` accepts anything | — |
| EXPORT-STEP-26 | entity-name check | skipped | skipped |
| EXPORT-STEP-26 | created-id-reuse refusal | skipped | skipped |
| EXPORT-STEP-9 | id-space refusal | allocator saturates | allocator accepts any id |
| EXPORT-STEP-3 | conversion of appended records | appended records bypass conversion | appended records bypass conversion |
| EXPORT-STEP-11 | last-record rule | index keeps the first record | writer keeps every record |
| EXPORT-STEP-10 | `property_mutations_refused` | counter not incremented | — |

Observed locally on the mutated tree:
- `step_writer_refusals.rs`: 6 of 6 fail.
- `step_log_parity.rs`: 2 of 7 fail (the conversion and duplicate-id cases, and the refused-by-both case).
- `step_index` unit test: fails.
- `step-log.parity.test.ts` + `step-appended-record-guards.test.ts`: 7 of 62 fail.

Once `step_ids.rs` is on `main`, the ordinary whole-change revert resumes automatically, because the `elif` matches only while the PR adds that file.
