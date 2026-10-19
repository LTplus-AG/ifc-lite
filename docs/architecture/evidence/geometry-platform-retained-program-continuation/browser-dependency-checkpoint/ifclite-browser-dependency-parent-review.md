# Browser dependency checkpoint: independent static review

Reviewed immutable `df8ff4fd4676fc4cf4bb6a65d37ebcefaa9228dc` against `1aceb23744dd9d37b45a7b8354f57dabae4c6c23` in `/home/louistrue/.t3/worktrees/ifc-lite/t3-65e5b823`. All 14 changed working files match the requested commit. Exact source/supporting hashes are in `/tmp/ifclite-browser-dependency-parent-review-hashes.json`.

**No concrete static blocker found within the checkpoint's declared runtime prerequisite scope.** No source edits, builds, tests, heavy jobs, network calls or child agents were performed. Six reported protocol/lifetime fixture passes are not SDK numerical or browser-Rust runtime qualification. Final target compile, real worker execution and five authored browser tests remain UNRUN.

## Actual worker and object authority

`BrowserDependency::input` validates the actual realization/result owner, local lease state and actual private driver's object membership. `evaluate_retained_boolean` requires Arc pointer identity with the executing BrowserWorker for both operands, before arming cancellation. Caller-supplied incarnation integers cannot establish that identity. BrowserObjectHandle is an opaque Arc identity whose cloning supplies no lease; result construction and actual JS object remain private.

The JS driver likewise accepts only object tokens already present in that driver's private Map. It rechecks membership after awaited startup/queued cleanup, before capturing operands. Handles are generated/validated against the real private session; alias checks reject a result matching either live source and reject the transformed temporary as the Boolean result. The driver and Worker object are not caller injectable in production. Fixture transport injection uses VM import substitution only in the explicitly labeled fixture tests.

The source-only constructor remains the default and retains whole-worker teardown when a source realization drops. The explicit constructor selects independent per-object source Drop; dependency result Drop releases its own actual object. BrowserWorker Drop/explicit retire still retire the entire captured worker, so independence does not mean results survive dropping their owning BrowserWorker. They can survive dropping both input realizations while that worker remains live.

## Order, immutable frames and numerical placement

The runtime captures actual ordered left/right opaque handles, operation, and both resolved f64 evaluation frames into a private result identity. The source frame is `world_from_source * source_from_evaluation`; result frames are already sealed. All require proper rigid affine matrices with positive orientation. Caller-owned matrices are copied into Rust values and then synchronously copied by JS before its first await, preventing later mutation from changing the issued coefficients.

The relative transform is inverse-left times right: rotation transpose products and f64 translation subtraction before rotation. Only the right object is copied/transformed; the ordered Boolean receives the original left and that temporary. Result mesh/frame remains in left evaluation coordinates, and lineage preserves both branches. Checked operation count includes both repeated branches rather than deduplicating a repeated dependency. The native multiply/rigid/relative helpers were moved with the same arithmetic, traversal order, tolerance and mapped error text; no numerical rewrite was found.

This is immutable **actual completion identity**, not independent transaction expectation validation. ProductState/common-program slots, stage/ticket acceptance, expected-vs-received comparison and complete final-net/appearance coverage are expressly not implemented. The return type and documentation do not turn numerical lineage into source authority or complete-product certification. That remains required work, not a claimed passing invariant at this checkpoint.

## Cancellation, release and primary errors

Rust InFlight is armed before awaiting numerical work. Cancellation, dropped future, bridge decode error, or invalid actual object retires only the captured Arc owner, invalidating every object in that owner. Foreign dependencies reject before arming this guard and do not touch either foreign worker.

JS busy ownership serializes numerical submission and queued releases. `releaseObject` deletes the exact token before asynchronous release, preventing reuse as a new dependency. Releases queued during active work wait until that work leaves its busy section; next work awaits an existing cleanup promise. Release failure invalidates/retire the captured driver and logs the error; it cannot silently keep a live unowned object. Unknown numerical failure similarly retires that owner and rethrows the primary error rather than retrying or replacing it with a cleanup failure. Session lifetime remains covered by captured Worker retirement.

The moved operand is explicitly released before sealing the numerical result, and the temporary mesh is released before the object token is published. A failed intermediate release retires the owner, covering any unpublished solid/mesh. Rust result construction failure/cancellation likewise keeps InFlight armed. Successful source/result objects have independent private map entries; dropping both sources removes only those entries, leaving the independently returned Boolean object. No bare wire handle escapes to mint a result lease.

## Qualification and honest limits

Independent mode runs the actual sweep contract and actual Boolean contract through the same captured transport/incarnation before the JS dependency gate opens. Rust also requires its successful qualification state. Source-only qualification cannot set the dependency gate. A worker retirement invalidates actual liveness, so old flags cannot authorize a replacement. Capability negotiation alone cannot grant qualification.

Reported fixtures cover ordered operand dispatch, copied matrix capture, input/result independence, stale/foreign/nonrigid refusal, delayed/failed releases, primary error preservation, gate separation and wire alias rejection. Their deliberately synthetic mesh data and substituted qualification modules establish protocol/lifetime behavior only. Authored browser tests contain real geometry volume, repeated-result use, input drop, far-frame identity and cancellation cases, but have not run; actual browser runner asset staging is itself listed as pending.

No all-platform compile, SDK numerical validity, source-binding closure, final-net completeness, full heap/RSS bound or performance improvement is inferred. The native resource/operator public paths remain separate, and the explicit checkpoint does not replace the permanent default exact consumer.
