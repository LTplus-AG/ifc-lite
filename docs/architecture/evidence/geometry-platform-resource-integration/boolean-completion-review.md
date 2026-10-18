# Boolean completion acceptance implementation

Changed only these four shared-root paths, uncommitted:

- `rust/geometry/src/program/boolean/work.rs`
- `rust/geometry/src/program/boolean/work_tests.rs`
- `rust/geometry/src/program/boolean/step.rs`
- `rust/geometry/src/program/boolean/batch.rs`

`Completed<Group>::assemble_group` now observes the current terminal before any provisional rewind. A stop consumes/assembles reached numerical failures into the actual recorder, preserves both prior and provisional records, and returns the typed terminal. The batch caller delegates to that helper; its duplicate manual stop branch was removed. Ordinary nonterminal deferral retains the previous rewind behavior.

`Completed<Single>::assemble_single` consumes/publishes reached numerical effects, then checks the terminal before exposing `Done` or `Fallback`. The production step and existing canonical single-cutter acceptance test now use the checked helper. `PendingEffects` and its source-free unwind target remain unchanged.

Two new direct regression tests use actual `Execute` numerical completions, then stop before consuming acceptance:

1. `terminal_group_acceptance_keeps_provisional_and_reached_numerical_records` tests a real volume-eight cube subtracted by an identical real cube (genuine full-removal deferral), plus the established empty-cutter failure case (actual `CutterUnionUnavailable` numerical record). A separate actual normal completion proves the deferral and expected numerical records. After cancellation, checked acceptance returns `ProgramStopped(Cancelled)` and preserves prior, provisional and reached numerical records in order.
2. `terminal_single_acceptance_cannot_publish_fallback_or_drop_reached_records` uses identical real cube solids. Normal numerical completion requests fallback and retains the volume-eight host. The same work, stopped after completion, returns the typed terminal instead of exposing fallback, preserves prior/provisional/numerical records and produces no plane-fallback diagnostic.

Neither test fabricates an executor/result or changes a production fault-injection hook. Normal control executions establish the actual numerical branches; source-free completed inputs can pause naturally before consuming acceptance.

Validation performed: syntax-only rustfmt parsing with `--emit stdout --config skip_children=true` on the four files, exit zero. Formatted stdout is confined to `/tmp`; no source formatting was applied. No Cargo, rustc build/type validation, test execution or heavy submission was run. Parent owns the coordinated actual compilation/tests. All changed production modules/functions remain below their existing new-module/function limits by inspection; no allowances changed.
