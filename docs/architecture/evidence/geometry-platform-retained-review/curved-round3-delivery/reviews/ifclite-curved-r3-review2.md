# Independent curved round-3 review, round 2

Verdict at `4e278251eed17044c58c9ce0615022259ad9c880`: **one new P2 lifetime blocker** in the selected rational-disk SDK route. Both preceding round-1 blockers are corrected in source. No execution qualification is supplied by this review.

Read-only inspection of the requested checkpoint, its round-3 changes after `bf94476593`, the prior original/correction review reports and implementation interfaces under `/tmp/ifclite-retained-authored-preservation-round2/reviews`, and `/tmp/ifclite-curved-r3-review1.md`. Parent `390c218c6f`, retained delivery `ccea8d2365`, source-policy correction `bf94476593`, and the new coefficient/consumption tests in `dee8399289` were considered. Actual SDK HEAD is `c9c5979f04cea8c38213004d4f04df0dcfb40d05`. Companion JSON records committed target and observed working-file hashes separately.

Only this report and its companion JSON were written. No repository/SDK edits, builds, tests, compiler or syntax probes, jobs, checkouts, publication, delegation, job inspection or retries. Fleet status reported Pop reachable/admission allowed, PC reachable, Mac disabled; that is capacity metadata, not an execution result. Neither the freshly submitted workspace request nor the preserved unknown original request was inspected, retried or changed. The supplied PC disk state was not remeasured. SDK/native/module/browser/workspace/Clippy/performance remain UNRUN/UNQUALIFIED by this review.

## P2 — newly selected pipe helper leaks its temporary profile on each call

Repository call site: `native/smlib-adapter/src/disk.cpp:70` invokes `SmApiCreatePipeSweep(radius,path.get(),TRUE,raw)`. Adapter RAII owns the input path and returned BRep, but cannot own a temporary hidden inside that helper.

Concrete pinned-SDK ownership chain:

- `source/SM_API/src/SmApiBrep.cpp:1376-1409` constructs a BRep and delegates to `SmPrimitiveCreation::CreatePipeSweep`. On failure it deletes that BRep; on success it returns it.
- `source/SMLib/src/SmPrimitiveCreation.cpp:6876-6881` allocates `pCircle` through `SmCircle::CreateCanonical` and puts its pointer into local `SmTArray<SmCurve*> sShapeCurves`.
- `SmCircle.cpp:197` implements that construction with `new (crContext) SmCircle`. This is an independent heap object, not a BRep-owned topology entity.
- `SmPrimitiveCreation.cpp:4898-4922` treats the profile as borrowed and creates new curve copies. Its cleanup guard owns those copies, not `pCircle`. The path is also copied and independently cleaned.
- The enclosing pipe helper returns at line6899 without deleting or guarding `pCircle`, including when `SER(CreateCurveSweep(...))` exits on error. `SmTArray.h:390-411` explicitly frees only the pointer array, never its pointed-to members. The context argument is not ownership: `SmObject.cpp:338-354` allocates with `smos_Calloc` and stores the context pointer.

Thus each supported pipe invocation reaching circle construction loses one original circle allocation (and its owned curve storage). Successful volume/manifold/tessellation checks and releasing the returned solid do not reclaim it. The private rational qualification itself invokes this helper twice, then opens a gate for repeated construction on the same long-lived process. Whole-process retirement eventually reclaims memory, but normal successful construction/release does not retire the worker. This is a concrete object-lifetime defect, distinct from an unproved hard heap limit or a hypothetical allocator failure.

Narrow repair under the current immutable SDK pin: make the adapter own the circular profile with RAII and use the available borrowed-input curve-sweep route, with explicit pipe-equivalent cap/orientation/centering options and deliberate tolerance handling. The public `SmApiCreateCurveSweep` declaration at `SmApiBrep.h:273-289` and implementation at `SmApiBrep.cpp:1475` provide that route; inspect its tolerance difference before substituting it. Alternatively, a separately approved upstream/pin correction could guard the temporary inside the SDK helper, but editing the pinned checkout in place would violate the adapter's clean-pin check. Merely wrapping the returned BRep again, releasing handles, or relaxing gates cannot repair the hidden allocation.

Future evidence: repeated same-process construct/query/release of straight and curved pipes, plus a failing sweep after profile construction, with allocation/leak instrumentation demonstrating the profile is reclaimed. Retain independent geometry and original-input immutability assertions. No such experiment was run here.

## Previous blockers and parent corrections

The ambiguous integer record now starts with `4u32` in `worker_disk_qualification.rs:48`; the full record therefore has the required LE-u32 width. This resolves the identified source inference error without changing layout. This statement is not a compiler verdict.

`retained_authored_evaluator.rs:258` now admits and lowers the circle, requires `OrderedRegion`, then gates real-worker assertions on `IFCLITE_SMLIB_WORKER`. It checks pre-qualification refusal, the same live incarnation, actual six-case qualification, positive circle volume, and refusal on a fresh replacement. This removes the contradictory unconditional source-refusal assertion. Actual SDK execution remains unrun.

`SourceCapture` clears partial records and latches independent `capture_status` on failure. Interpreted legacy geometry/status remains separate; rational ownership and retained admission require complete capture. New malformed-edge and real-budget tests assert that previously complete line/profile geometry survives provenance refusal. They were inspected, not executed.

Release removes the tracked object Arc and marks it dead before sending the command. Both retained source and dependency receipts check that flag together with actual process liveness. Reused slots/generations get a fresh flag. The bound release-before-accept test checks a still-live process, dead realization, unchanged document revision, and preserved rejected numerical buffers. Ticket identity is checked before source-expiry retirement, preserving foreign receipts; weak pending tickets retain the prior admission recovery fix.

## Consumption, authority and remaining scope

Boxing `RetainedConstruction` variants preserves the same owned request/lowering boundary. Original line/vector coefficients, trim selectors/flags, composite metadata, rational degree/controls/weights/knots/multiplicities and unit metadata remain distinct from numerical traversal and normalized evaluation data. Nonunit line ratios are normalized before Magnitude by the existing shared reader; the new authored coefficient tests exercise that behavior. No additional loader was introduced.

Ordered region lowering uses explicit outer/inner roles, connectivity, independent signed area, bounded counts and derived-only winding reversal. General regions require a private same-incarnation runtime witness before upload. Rectangle exemption checks actual rectangle geometry as well as profile identity. Rational disk lowering retains original controls/parameter domain, subtracts a local anchor, converts coordinates/radius to metres once, and retains inverse scale/anchor outside the SDK. The pinned canonical-curve API takes Euclidean controls, matching knots/multiplicities, weights and trim. Reverse/Cartesian-master rational trims and solid bounds over an already trimmed rational directrix remain explicit refusals.

`dee8399289` adds meaningful numerical source/unit invariants and actual-SDK-gated bound rational consumption and copied-frame Boolean assertions. These do not establish execution by their presence, and the synthetic IFC invariants are not real-authoring-tool qualification. Copied dependencies compose occurrence/evaluation frames, reject nonrigid metre frames, subtract world translations before rotation, copy before transforming, preserve original operands, and retain separate result lineage. No additional definite frame or authority blocker was established in the inspected target.

The canonical decoder admission policy correction remains present: standalone scans retain scanned-record semantics, while bound admission reuses actual leased decoder/cache policy and deduplicates selected IDs. Bound plans remain private, source lifecycle remains a small token, and canonical acceptance consumes the sealed executor receipt rather than a caller-created completion. Full final-net ProductProgram integration and coverage accounting remain sibling-owned; a source/dependency result does not certify complete products.

Rational planar regions, closed/hollow/multisegment disk routes, unsupported trim conventions, robust general self-intersection certification, scale/shear/reflection, full application/native-browser binding, retained USD, IFC appearance/UVs/smooth normals/persistent faces, hard heap bounds and performance remain residual or unqualified scope. Exact remains permanent/default; retained remains explicit without automatic fallback or replay.

During review HEAD advanced to `72ba366be053d1a0693c2684b6da2455899eddfe`, adding sealed dependency operation identity and corresponding assertions. Its four-file diff was read to distinguish moving working bytes; this verdict remains pinned to requested `4e278251ee` and does not certify sibling final-product acceptance. No source was reverted or modified. Hash JSON records the distinction.

Next concrete work: repair adapter ownership around pipe profile construction, checkpoint it, then collect admitted native/CTest and actual bound-consumer evidence from the assembled source. The parent owns the already-submitted workspace request and any later original-receipt inspection. Follow with required workspace Clippy, actual module/browser qualification and relevant base/branch performance evidence; preserve all gates and explicit residual coverage until those results exist.
