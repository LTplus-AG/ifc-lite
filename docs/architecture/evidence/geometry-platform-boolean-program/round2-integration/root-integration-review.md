# Root Boolean integration static review

Read-only inspection of the dirty root based on HEAD `e26527d79c34ed98160c8104e2def7edf9e8dd32`, after integrated round2 and the graph recorder fix. Exact inspected hashes are in `/tmp/ifclite-boolean-root-integration-review-hashes.json`. This snapshot includes the added PendingEffects numerical unwind-forwarding guard and its actual-plane invariant test. No builds, tests, gate executions, fleet jobs, source changes or extra agents.

## Result

No remaining concrete Rust type/visibility/borrow/move blocker identified in the inspected integration. The previously found graph mismatch is fixed: `construction/brep_operand.rs:65-66` now forwards `&recorder.effects` to `ReadyVoids::subtract`.

This is a static call-site audit, not compilation, Clippy, runtime or performance evidence. Capacity-blocked qualification remains open.

## Recorder signature and caller audit

- `NumericalEffects` contains only `RefCell<Vec<BoolFailure>>`; derived default has no schema or source dispatcher. Actual Boolean processors retain their schema for real source admission and hold their own NumericalEffects log.
- `Execute` implementations uniformly receive `&NumericalEffects`. Plane and Single call the numerical log's full-host guard; Single calls the moved gate; Solid calls `evaluate_admitted`; Group calls the moved group numerical evaluator; Voids forwards the numerical log to `ReadyVoids::subtract`. Constructor, Prism and Shell implementations ignore this recorder and use existing source-free evaluate methods.
- SolidBooleanPlan's existing graph/test `evaluate(&BooleanClippingProcessor, ...)` compatibility entry deliberately forwards `&recorder.effects`. Its program-side `evaluate_admitted` callers supply the already-correct numerical recorder. Configured cut policy stays in SolidBooleanPlan, not in the effect sink.
- All three direct ReadyVoids call-site groups now match: common work, graph BrepOperandPlan, and two owned void tests. Source-side shell/void refusals use `refuse_source`, which forwards to the actual processor's effects; no source admission failure is routed into an unassembled private log.
- Moved `subtract_checked`, `build_cutter_union`, full-host guard and gate receiver call sites resolve to NumericalEffects. The `pub(super)` cutter-union method is called from its sibling implementation inside the same Boolean module; visibility is sufficient. NumericalEffects and the actual processor effects field are crate-visible for construction callers.
- Boolean processor public trait drain/count/truncate methods forward to its actual effects log. No caller constructs a Boolean processor with the removed `failures` field. Other `.failures` fields belong to independent clipper/CSG types and remain unchanged.
- Moved step methods are `pub(super)` within `program::boolean::step`, sufficient for parent BooleanProgram and child step tests. Execute/Completed visibility is sufficient for the sibling work/operand/batch/step tests. Private test-only `process_operand_checked`/`without_voids` adapters forward to the common implementation; their remaining callers are cfg(test).

## Ownership and restoration

The RestoringProgram guard contains the owned child plus the lexical caller path borrow. No borrowed path is stored inside BooleanProgram. Tail-returned `run` produces an owned Result before guard Drop restores the actual moved path. Normal Result cleanup removes this child's active memberships; unwind bypasses that cleanup and restores active members, ancestors and spent visits, matching the borrowed baseline's unwind behavior. There is no panic-catching production wrapper.

Owned numerical payload fields move through execute/evaluate into typed Completed output, then consuming assembly. Existing inherent `OwnedConstructor::evaluate` and `ShellPlan::evaluate` resolve ahead of the Execute trait method of the same name; those forwarding implementations do not recursively call themselves. Borrowed RefCell values are not retained across execute or guard lifetime in reviewed production call sites.

## Remaining static documentation debt

Three live architecture documents still name deleted continuation files:

- `docs/architecture/geometry-platform-capabilities.md:126` describes `processors/boolean/continuation{,_state,_batch}.rs` as current owners.
- `docs/architecture/geometry-platform-product-program.md:44` links the deleted continuation.rs and says Driver still borrows decoder/recorder for the run.
- `docs/architecture/geometry-platform-next-steps.md:204` describes the old path as current implementation.

`program/mod.rs:4-6` also retains the older module overview saying Boolean continuation has its existing separate owner. These are stale current-state references to update with the integration; historical receipts and historical test comments about removed helper names should retain their provenance. No production references to deleted helper methods or old module declarations remain. The remaining `mod continuation_tests` names a live test module and is valid.

## Module/function scope

New/changed Boolean production files are all below400 lines: largest `program/boolean/mod.rs`199, work.rs164, processor operand.rs145, group execution138. No newly moved/new function approaches150 lines; these modules contain multiple small functions. The graph caller file is155 lines including its sibling inline tests. Searches of module/function/positional allowlists found no stale rows for the deleted Boolean continuation/step paths. Existing diagnostics remains its previously allowlisted module and changes only a comment. No allowance increase or digest edit is needed for these Boolean changes as inspected. This is line/source inspection, not execution of ratchet gates.

## Integrated numerical unwind forwarding

The latest `work.rs::PendingEffects` owns the local NumericalEffects plus only a lexical borrow of the actual effects target. Execute evaluates against the local log, drains records into Completed on normal return, then Drop finds an empty local log and publishes nothing. If evaluation unwinds, Drop drains still-pending records and appends them to the actual target. This uses emptiness after a successful drain as its effective disarm rather than a `thread::panicking()` test. No catch, schema, decoder, router or source callback is retained. All reviewed production/test execute callers now pass the actual processor effects target; no zero-argument call remains in the Boolean module.

Existing call sites hold no actual-log RefCell borrow across execute. `local.take_failures()` releases its temporary local borrow before target `absorb_failures` starts, avoiding a known reentrancy conflict. Prior actual records remain first, followed by the local numerical records in reached order. The consuming normal assembly path still appends exactly once. As with every destructor that appends to RefCell state, retaining an external target-log borrow across numerical evaluation would make unwind forwarding vulnerable to a second panic, but no such borrow exists in the reviewed paths.

The added `numerical_unwind_keeps_prior_and_reached_plane_losses_in_order` test invokes actual Plane evaluation with the fallback record, independently verifies the clipped block volume4, then deliberately unwinds. It catches the exact panic outside production and checks one prior record followed by one reached fallback record. This tests a real numerical record and real clipping before the fault, not a fabricated result. It remains uncompiled/unexecuted at this snapshot.

Group rollback retains the previously described caveat: local mark0 rollback is isolated until normal assemble_group updates the actual provisional mark. Forwarding only the local remaining Vec cannot itself replay an actual-mark rewind if an unwind occurred after local rewind but before completion. Present group code has only log transfer/record creation and return after those rewind branches, with no later user callback or kernel invocation; no source-triggered numerical unwind at that location is identified. Do not generalize append forwarding into arbitrary rollback-delta authentication. This does not block the current concrete plane/solid record preservation fix.

All previous restrictions remain: historical source-recovery catches need typed resource terminal propagation on future integration; no detached reply identities or complete resource envelope is implemented; no new numerical route/default kernel/loader is introduced. Final admitted compile and runtime/corpus qualification are still required.
