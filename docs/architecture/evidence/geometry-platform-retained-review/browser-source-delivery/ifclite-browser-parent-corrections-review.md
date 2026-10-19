# Browser parent corrections: immutable static review

Inspected cancellation checkpoint `763f215f93` and rational qualification checkpoint `5e84bbf3fc` through Git blobs only. Full immutable commit/blob identities, SHA-256 hashes and lengths are in `/tmp/ifclite-browser-parent-corrections-review-hashes.json`. Prior context: `/tmp/ifclite-browser-retained-parent-runtime-review.md` and `/tmp/ifclite-browser-retained-parent-source-review.md`.

No new concrete source blocker established in these corrections. The earlier mutable-executor cancellation gap and missing curved-rational witness are addressed at the source/API level. This is not a successful assembled build, real SDK run or actual browser qualification. I made no source changes, builds, tests, compiler/syntax probes, heavy requests or job mutations.

## Independent cancellation capability

BrowserCancellation holds only a private Arc of the actual captured Owner. It exposes synchronous explicit retire, with no numeric identity constructor, response/transport injection, replacement lookup or qualification operation. BrowserWorker::cancellation clones that owner independently of the executor wrapper. The exported RetainedBrowserCancellation is a separate wasm-bindgen object obtained before the async call; retiring it borrows its own wrapper, not the RetainedBrowserExecutor that source.execute holds mutably across awaits. This repairs the concrete same-wrapper borrow obstruction without making evaluate reentrant or relaxing the private driver busy check.

Passive cancellation-handle destruction only drops its Arc; it has no cancel-on-drop implementation. While the executor remains alive, freeing a temporary capability does not retire the owner. Executor destruction and last Owner destruction retain their explicit retirement behavior. Multiple capabilities still reference exactly that captured owner. Repeated retire uses the existing AtomicBool swap and is idempotent. Nothing resolves a later executor by numeric ID, and the JS driver retires only its captured transport incarnation. An old capability cannot retire a separately constructed replacement.

The prior startup and Rust InFlight ownership remain: retiring before dynamic import settles sets #retired, and the constructor continuation checks it before allocating a Worker. Retiring during a driver command invalidates the object Map before terminating transport; pending work rejects and Rust post-await validation cannot manufacture a receipt. A dropped polled Rust future still retires its captured owner. Ignoring a JavaScript Promise is not cancellation; the independent explicit capability is now the usable JavaScript operation.

The public contract now captures cancellation before source.execute, calls retire synchronously while its Promise is pending, requires that Promise to reject, creates a new source/executor, invokes the old capability again, then requires actual known rectangle geometry and occurrence placement from the replacement. It frees the capability in finally. These are meaningful authored API assertions, not a fabricated response test.

Remaining test scope: this immediate synchronous cancellation primarily covers the pending wasm mutable borrow/startup window. It does not prove a command was submitted to the Worker before cancellation; deterministic after-dispatch cancellation still needs a real transport event/barrier. It also does not explicitly call source.display and assert absent publication before freeing the cancelled source. The replacement success is strong stale-owner evidence once actually executed. No such browser execution was performed by this review.

## Earlier publication authority repair remains present

PublishedBrowserSource fields are private with read-only getters. validate_browser_publication first calls the receiving GeometryDocument::mesh for the sealed definition handle. The called definition lookup checks exact DocumentId, slot existence and generation before lifecycle-triggered retirement. A foreign expired receiver therefore returns ownership failure before gaining authority over the supplied realization. accept_browser retains its private ticket-before-expiry ordering. This statically closes the4168 foreign-retirement path; actual two-document behavioral qualification remains necessary.

## Curved rational target witness

The5e84 runSweepContract now includes rationalDiskWitnesses: both the original degree1 straight pipe and a genuine format2 degree2 weighted rational quarter-circle pipe. The new recipe has Euclidean controls (4,0,0), (4,4,0), (0,4,0), weights1,sqrt(1/2),1, clamped knots0/1 with multiplicities3, and radius0.25. Its wire layout and coefficient-derived path are independently checked by the helper tests. It is not a format1 circle extrusion standing in for the rational-directrix route.

The actual contract uploads that recipe using the same supplied transport, captured incarnation and fresh session as the other cases, queries SDK volume/manifold, tessellates the original and an actual copied rigid transform, verifies the original remains unchanged, then releases all handles. RetainedDriver.qualify opens #qualified only after this whole actual contract succeeds and live() still matches its captured Worker. Capability negotiation, caller flags or a native probe do not open the gate independently. A failed witness retires that driver. Source-bound RationalDisk consumption therefore now depends on actual execution of the curved route on that Worker.

The independent expected geometry is consistent: centreline radius4 over a quarter turn has length2π; tube radius1/4 gives volumeπ²/8, lateral areaπ² and two end-cap areaπ/8. Tight bounds are x/y0..4.25 and z±0.25. The mesh oracle checks those bounds, vertices against the torus-tube or endpoint-cap surface, quadrant restrictions, independent triangle surface and volume, finite/index/closed mesh metadata, and inverse-transformed copied positions. Its cyclic transform inverse matches the tested copy matrix. The fixture-only synthetic mesh helper tests include a valid quarter pipe and a volume-preserving translated rejection; they test the oracle, not SDK output.

The new source list has twelve numerical recipe cases (two direct region cases, two rational disk cases, eight regionWitnesses), plus separate lifecycle/cleanup assertions. This count is not an executed-case receipt. The parent-supplied26 fixture-test result is not independently rerun or promoted to SDK/browser evidence by this review. SDK-dependent tolerance success, topology/surface fidelity and actual module/browser consumption remain unqualified until an admitted matching-artifact run.

The earlier witness cleanup improvement is also present: a session cleanup failure retires the captured incarnation and preserves/logs an already active primary oracle failure, rather than masking it. A cleanup-only failure still fails qualification.

## Remaining scope

Required next evidence includes assembled canonical WASM/types, real deployed adapter assets and actual browser source/cancellation/curved consumption tests at the same source/runtime pin. Full native/browser source and millimetre/frame parity is not established by matching recipe formulas. Curve/source/appearance/UV/persistent-face and complete IFC coverage remain separate contracts.

Common ProductProgram retained issuance/acceptance and final-net Boolean/opening/representation coverage are still absent. The source-only retained browser publication must not be described as that completed integration or as a default exact-kernel replacement. This report qualifies neither later source nor any runtime/performance result.
