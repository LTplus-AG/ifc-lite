# Boolean preservation correction review

Read-only inspection of clean checkpoint `a3cefb1b61dc51ca5ae227c381f0fdd063231f1b` in `/home/louistrue/.t3/worktrees/ifc-lite/t3-106818eb`, correction baseline `840ae6c70f45972287543a6327ed0f16c67b4b20`, inherited parent `288932a2474c2e78692a8403c345bb1d273b7c71`. All changed/deleted candidate file hashes match the delivery manifest. Exact inspected and delivery hashes are in `/tmp/ifclite-common-boolean-round2-review-hashes.json`. No edits, builds, tests, network calls, fleet submissions or new agents.

## Blocker: unchanged production graph caller has wrong recorder type

`rust/geometry/src/construction/brep_operand.rs:65-66` calls:

```rust
VoidPreparation::Ready(ready) => ready.subtract(outer, self.length_unit_scale,
    recorder, self.operator, &self.operand_type),
```

Here `recorder` is `&BooleanClippingProcessor`, from the enclosing `evaluate` signature at line57. Round two changed `ReadyVoids::subtract` in `processors/boolean/void_evaluation.rs:19` to require `&NumericalEffects`. BooleanClippingProcessor has a contained `effects` field and no Deref coercion to that type. This is a concrete type mismatch in production code, not a test-only or optional-runtime path. The correction updated direct void tests and the common work caller but missed this existing graph consumer. Forward `&recorder.effects`, or provide a deliberate wrapper with the previous source-recorder signature; then compile the complete crate and relevant graph cavity tests. No compiler was run during this review.

## Previous hot schema allocation is removed at the numerical seam

`work.rs::Execute::execute` now constructs `NumericalEffects::default()`. The actual type in `processors/boolean/effects.rs` contains only `RefCell<Vec<BoolFailure>>`; its derived default creates an empty Vec with no backing allocation. It does not construct a fake schema, source dispatcher, processor, router, decoder or opaque helper that retains source capabilities. Constructor, Prism and Shell execution no longer initialize an unused IfcSchema.

The existing numerical helper implementations have moved from `impl BooleanClippingProcessor` to `impl NumericalEffects`: full-host guard, single-cutter gate, group execution, cutter union and checked subtraction. The reviewed correction changes their receiver/imports, not their numerical bodies. SolidBooleanPlan receives the effects log at its admitted numerical entry; its existing graph compatibility method forwards the selected processor's actual log. Source admission refusals use the explicit `refuse_source` forwarding wrapper. Selected processors retain schema only for their actual builtin source-dispatch work.

This resolves the identified per-operation schema-construction mechanism by source factoring. It is not measured allocation, latency, RSS or whole-pool neutrality evidence.

## Path restoration now covers unwind without swallowing panic

`RestoringProgram` is a lexical synchronous-driver guard, containing the owned BooleanProgram and a borrow of the caller's OperandPath. Its Drop restores the actual owned path using `mem::take`, so normal success, returned error and unwind all return the actual ancestors and spent visit counter. The BooleanProgram itself still owns its path and frames and retains no decoder/path borrow or runtime guard between internal transitions. Only the enclosing synchronous compatibility driver holds the caller reference, as intended.

Normal Result completion still drains the child's active admissions before the guard restores the caller. On unwind, the active admissions are retained along with ancestors and spent visits, matching the original borrowed Driver's behavior rather than inventing cleanup or resetting the allowance. The production code adds no catch_unwind: the original panic continues outward. Guard Drop performs no geometry, diagnostic drain, source lookup or active set iteration; it cannot swallow an ordinary returned error or replace the numerical result.

Construction of the guard occurs around the existing synchronous drive. This does not create a detachable scheduler API; moving a future suspended child out of that guard would require a separate ownership protocol.

## New tests are meaningful contract probes, but unexecuted

The two `unwind_tests.rs` cases use real decoded blocks and actual Boolean control. The fault injection is a thread-local one-shot at AfterBase, after a real owned block has evaluated; it independently verifies volume8 before panicking. The test catches the exact panic payload outside production, verifies seeded ancestor900 and active root2 survive, and exhausts the remaining monotonic visit allowance to prove exactly eight visits are spent. It tests restoration of actual state altered by real control, not a mock's preselected return.

The companion success/error case performs nested actual unions. Success verifies volume8; the error case reaches depth11 after earlier real bases, then verifies only the ancestor remains and that all twelve charged node entries remain spent. These expectations match the current contextual depth admission order, including charging the failing entry.

The ordered-loss test constructs an actual block through unknown-operator, unsupported-RHS and missing-RHS steps; it asserts retained host volume8 and the complete ordered three-record loss sequence. The prior group rollback, shared DAG, selected-hook/fresh-builtin dispatch and configured small-cut tests remain present.

These tests have not compiled or executed on final source. Their source quality does not substitute for runtime evidence. The existing dirty1531 pass remains explicitly inapplicable to this checkpoint.

## Preserved policies and remaining limits

No correction to reached operator/RHS ordering, empty-host skips, lazy unit discovery, conditional void-shell admission, CSG depth/reset/path policy, group replay, census hooks or configured root versus fresh builtin operand policy was found. Step and batch control files, builtin registry and CSG primitive entry are unchanged relative to the round-two baseline. A read-only comparison also found no changes to inherited parent layer sources or gateway.

Completed numerical work still owns only Boolean failure effects, publishing them on returned Result through consuming assembly. It does not preserve a temporary numerical sink's records if that numerical work itself unwinds; the delivery explicitly disclaims that stronger contract and no input-driven numerical panic reproduction is claimed. Path restoration is now corrected independently.

Resource terminal propagation remains separate: broad historical catches around bounded prism/group/shell source loss must recognize ResourceRefused/Cancelled when those errors are integrated, rather than converting them to historical host recovery. No new resource-safe claim is supported by this correction. Private completion classes do not authenticate operation-instance/session/source IDs for detached replies. Exact remains the default/permanent kernel, with no routing or loader change.

Final qualification remains blocked and uncompiled. The wrong-type graph call must be corrected before an admitted final compile; thereafter run crate/workspace/all-target Clippy and actual native/WASM/corpus comparisons, with whole-pool performance qualification. No passing result is asserted by this review.
