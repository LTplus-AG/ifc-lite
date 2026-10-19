# P2 processing/runtime boundary review

Immutable source inspected:818a51829ada20435410cdc28e4eed09ec990d1f vs2deba6d5dd1034eecc6b9f9b83c03449d22e78cd. Read through git objects, not advancing worktree files. Focus processing session_retained issuance/acceptance/native/value, entry/protocol/tests and consumed runtime APIs; geometry common traversal reviewed only as needed to trace payload/outcome binding. No edits, builds, tests or job submissions. Existing/new SDK tests remain UNRUN; fixture tests are not numerical proof.

## Concrete typed-stop blocker

acceptance.rs111–113 maps every error from pending.reply.bind_retained_outcome to RetainedExecutionError::Protocol. ProgramReply::bind_retained_outcome (geometry/program/inner.rs60–74) charges work before visiting each original reply envelope. Under a finite account this can return geometry::Error::ProgramStopped(ResourceRefused) before reaching the actual Boolean reply. The processing API then labels a genuine terminal resource refusal as a protocol error. The sticky account remains stopped, but that does not preserve the returned typed fault contract. No linear reply has been taken at this point.

Minimal correction: on bind failure prefer the authoritative self.resources.check().err() and return RetainedExecutionError::Stopped; otherwise translate an explicit Error::ProgramStopped directly, with ordinary geometry/protocol mismatches still mapped to Protocol. Follow existing acceptance.rs95–98 handling rather than adding a retry/fallback. Keep original WorkReply and ledger intact. Do not clear an already-bound valid outcome merely to retry after a terminal stop.

Meaningful qualification: deliver an actual SDK Boolean result under a bounded original account with enough remaining work for intact validation but too little for traversing its real nested outcome-binding envelopes. Assert typed Stopped with exact Work refusal, original common reply still owned, no ledger append, no downstream operand/kernel execution, and original source fault remains authoritative over foreign ambient terminal. Existing post-delivery account.cancel test fails before binding and does not cover this new charge site.

## Preserved ownership and linearity

- Parent retains the actual original WorkReply, exact outer and inner ProgramRequests, original OwnerStamp, immutable model-context identity, ticket Arc and stage Arc while executing the ordered batch. No replacement whole-product execution or second source walker is introduced by processing.
- Validation checks ticket/stage, lifecycle/actual decoder context, original outer/common/owner tuple and recursive state reply validation before any take. Result count, live captured incarnation, kind, construction same-admission/document completion frames, affine actual input handle/matrix and Boolean ordered actual handles/operator/both frames are checked before ledger publication.
- Logical inputs resolve existing ledger definitions and immutable Arc receipts, preserving shared definition geometry while occurrence frame/slot metadata stays in the expected operation. Operation outputs remain Operation definitions rather than fabricated construction source recipes. Geometry owns logical instructions only and imports no runtime crate.
- Sealed runtime objects are Arc-owned in the ledger and exposed outputs. CommonRetainedRealization owns the original resource context until its final reference is destroyed. Managed object leases provide per-object cleanup; cancellation still retires the captured actual worker. Foreign validation failures return the supplied work intact and cannot take the stored engine reply.
- Execution moves through ISSUED/EXECUTING/DELIVERED; acceptance CAS precedes take. On ordinary validation rejection the work remains owned; cancellation cannot be overwritten by a blind ACCEPTED store. An actual worker/runtime failure after an earlier batch result drops the local managed receipts; it never selects exact fallback. Runtime primary-error and cleanup behavior is inherited from the pinned base.
- Outcome binding occurs on the actual stored reply before consuming it. Source reports remain in their common-controller pending logs; source report cancellation must continue through the original program, not be replaced with fresh attribution. Explicit cancellation validates the real owner and reinstalls its scopes to forward reports.

## Integration and limits

The child session.rs delta is only execute_admission return Option->Vec and its accumulator initialization. Its whole-file snapshot predates parent's bf9f12270d entrance-cancellation repair. Apply those narrow signature changes while retaining every bf9f entrance snapshot/reassert/accept/cancel/report line. Replacing session.rs wholesale would reintroduce an actually observed publication regression.

The parent SDK semantic-empty helper844 is outside this child and must remain intact. Child runtime uses the base's managed lease and affine APIs; the geometry cross-controller binding guard is a separately reported child repair, not resolved by this processing review. No proof of halfspace, openings, layers, browser transaction or final-net appearance closure is claimed. SDK source coefficients/numerical scratch/process heap remain explicitly unqualified; coarse account retention is not whole-heap accounting.

Actual SDK tests are meaningful source assertions for A-A/disjoint empty chaining and lazy invalid-cutter skip, affine swapped/missing batch retry, wrong operation/context, stale input/cancelled stage, original resource cancellation and result survival. They remain runtime obligations, not passing evidence. No additional concrete processing blocker established beyond the typed-stop translation above.

Exact immutable inspected hashes: /tmp/ifclite-p2-818-processing-hashes.json.
