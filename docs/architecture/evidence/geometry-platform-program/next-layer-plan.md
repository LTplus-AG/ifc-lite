# Complete plan/execute/assemble after the representation/constructor layer

Read-only design against immutable child commit
88dc838c4fa74a21968c3735e3f2e751b165c5dd in
`/home/louistrue/.t3/worktrees/ifc-lite/t3-d63e73e7`. No source changes, builds,
tests or worker jobs. Inspected hashes accompany this document in
`/tmp/ifclite-program-next-layer-inspection.json`. This proposes implementation
boundaries; it does not relabel phase one as decoder-free product execution.

## Actual starting point

`docs/architecture/geometry-platform-product-program-phase-one.md` accurately
identifies the remaining gaps. `program/traversal.rs::ProductProgram` owns five
entry policies, representation and whole-item cursors and merged resources.
`program/product.rs` still synchronously invokes router source work for each
reached item. Mapping child machines are owned but run synchronously. Nineteen
selected-processor constructor payloads evaluate without a decoder/router;
annotation fill and triangulated texture admission have genuine owned inputs.
Processing's ProductState still owns attempt/retry and final presentation.

The next layer should make those existing control machines issue reached source
requests, owned numerical requests and explicit publication/assembly continuations.
It must not put the existing source-reading router call behind an Execute label.
The optional eager ConstructionBatch graph cannot replace this demand schedule:
empty operands, grouped-cutter deferral and late placement/unit admission make
source order observable. Existing opaque custom callbacks remain explicit leased
synchronous calls; their public registration contract is preserved permanently.

## Shared internal ownership contract

Geometry owns one common ProductProgram with typed child frames and resource
slots. Processing owns the same ProductState attempt authority and captured model
context; it drives the inner program instead of repeatedly asking for whole
router products. Public router methods and borrowed/owned producers become
synchronous drivers of this same core, with their exact signatures and defaults.
No parallel old geometry route remains. No new public ticket or asynchronous API
is required to implement the ownership seam.

Use distinct internal steps:

- `Admit(SourceStep)`: reaches actual decoder/index/placement/cache services under
  validated runtime ownership. Returns an owned source payload or typed historical
  source refusal, plus owned reports and the appropriate next continuation.
- `Execute(ReadyOperation)`: consumes admitted inputs and typed runtime geometry
  handles. It has no decoder, router, source string, mutable map callback or source
  replay mechanism. A runtime host/cutter mesh is a numerical input, not a source
  construction definition. Existing numerical builders remain unchanged.
- `Publish(EffectSet)` and `Assemble(ReadyPresentation)`: apply a validated reached
  effect once or assemble already resolved presentation data. Admission needed
  for presentation still happens at the original late lookup point.
- `LeasedExtensionCall`: invokes the actual selected processor against the live
  mutable decoder/actual router as today if it declines owned lowering. Do not
  invent a detached custom registry or substitute a builtin by IFC type. Such a
  call cannot be advertised as decoder-free or transportable.

Frames own selectors, path sets, visit counts, mesh handles, parameter payloads,
ordered diagnostics and provisional-attempt records. They never own a decoder,
RefCell borrow, TLS guard, telemetry transaction, router lock, cache lock or
per-element budget guard between steps. Per-poll scopes install the existing
ElementState/degenerate/pending state. Owned runtime handles must be generation
checked and move/release exactly once; they are not source-definition identities.
Source-bundle authentication and resource-account integration are separate ongoing
work, with explicit integration points below, not reimplemented here.

## Layer 1: migrate canonical Boolean/CSG control into the common program

Targets: `processors/boolean/continuation{,_state,_batch}.rs`, `step.rs`,
`operand.rs`, `csg_primitive.rs`, `csg_root.rs`, and new small `program/boolean/`
modules. Start by moving the current owned Frame/Walk/Steps state, OperandPath
and cleanup ownership into ProductProgram children. Remove Driver's retained
`&mut EntityDecoder`, recorder and visited borrows. An ephemeral synchronous
adapter supplies services per reached step, then public execute_boolean/execute_csg
drive this same child to completion. Do not replace policy with a newly designed
boolean traversal.

Required transitions are concrete:

1. Enter/check path and monotonic visit budget at the current entry points;
   FirstOperand spine nodes remain distinct from entered boolean operands.
   Guarded CSG inserts its wrapper; top-level unguarded CSG retains its current
   behavior. A CSG operand resets boolean depth but retains path/visit state.
2. Resolve validated CSG root or next FirstOperand only when reached. Preserve
   exact admissible root families, permissive attribute-index reads, errors and
   role-specific dispatch. Repeated DAG occurrences remain separate contributions.
3. Preserve speculative polygonal-chain collection BEFORE base evaluation, even
   if the base later proves empty. Store collected owned node identities and
   continuation; do not eagerly lower unused cutter descendants.
4. Once the base returns, empty Difference/Intersection skips SecondOperand.
   Empty Union records its loss BEFORE RHS source work. Unknown operator records
   and keeps host without resolving RHS. A missing RHS retains host except that
   Intersection becomes recorded empty geometry.
5. Admit specialized half-space/finite-boundary inputs only after the host/plane
   kept-side test reaches them. The existing HalfSpacePlan and BoundedPrismPlan
   already own plane/transform/sampled contour; reuse those actual payloads.
   Build finite prism depth from the actual host, not an arbitrary large solid.
6. For ordinary solids, own SolidBooleanPlan policy plus first/second resource
   handles and second_empty_recorded. Run `admit` before requesting unit discovery;
   empty/small-skipped cases must not read length units. Only Kernel admission
   requests the unit scale and emits the existing exact numerical operation.

Decoder-free operations include plane clip/cap with full-host-removal guard,
host-dependent bounded-prism generation, single-cutter admission, solid boolean,
and grouped prism subtraction. Their payloads own f64 plane/transform/contour,
quality and skip policy, lazy-resolved unit scale when required, and resource
handles. Numerical failure/refusal policies remain the original implementations.
Ordinary host roles keep Outer-only BRep semantics; operation operand roles
consume Voids. Reuse owned shell lower/evaluate and terminal source fault entries,
but do not eagerly decode all shells before an earlier shell can refuse.

Grouped cutter preparation becomes ordered child frames, one admitted cutter at
a time. Owned AttemptCheckpoint contains recorder identity/generation, diagnostic
mark and control location, not a live recorder borrow. Failed speculative
preparation/numerics rewinds only its provisional boolean records; source reports
and visits remain spent. Keep the original sequential replay from next_first.
Cancellation/resource stop must never enter this historical source-loss fallback.

Meaningful gates: current continuation, chain-cycle, step, grouped-cutter,
half-space-cap and BRep-with-void tests; committed bath CSG roots200/206/207/208;
wall/roof polygonal fixture roots1449/1450 plus constituents; repeated operand
DAG, late bad RHS, unknown operator with bad RHS, empty Union ordering, group
deferral and inherited path cleanup. Verify geometry/volume/topology and ordered
losses, not just selected strategy. Real optional fixtures skip honestly if absent.

## Layer 2: opening classification is an ordered child program

Targets: `router/voids/{mod,synthesis,probe,representation}.rs`,
`program/opening.rs`, `opening_bounds.rs`, and new `program/openings/` modules.
Phase one already owns per-item mesh/bounds probes. The missing part is the
classifier/capture schedule and resulting cut context, not another wrapper around
`build_void_context(element, decoder)`.

Own the host's ordered opening IDs, current opening identity, classification mode
(recording versus quiet residual), admitted item/mesh/bounds results and per-host
diagnostic accumulator. Preserve `classify_openings_impl` order: decode opening,
run IndexOnly body parts, skip failed/empty parts, compute triangle/vertex counts,
perform per-item bounds/direction and mesh probes, then apply existing geometry
classification thresholds. Multiple spatially separate items remain separate
cutters even if their aggregate triangle count would take a different branch;
touching/overlapping parts retain their merged policy. Quiet residual classification
must not bump aggregate classification or append duplicate host records.

Source requests must distinguish probe semantics. Opening representation admission
is intentionally more permissive than ordinary product shape validation. Whole
representations resolve before placement; placement before selected Items.
Bounds probes admit direction before geometry and bypass the raw-per-element
route; mesh probes try raw first. Failed placement can mean identity here.
A zero direction removes direction evidence, not the item's geometry. Do not
substitute the main product selector or one universal failure policy.

Capture source payloads from `voids/probe.rs`: owned RectParam/frame/dimensions,
ExtrudedSolidInfo with owned Profile2D including holes, f64 native-world transform,
depth/direction, and any role-specific clipping inputs. The bounded extrusion
wrapper walks retain their exact depth/visited behavior and first-item choices;
profile capture is not interchangeable with full representation traversal.
Each probe result is attached to its opening occurrence; never key detached
numerical completion solely by repeated opening/source ID.

The next data-dependent schedule remains exactly:
classification -> rectangular merge -> optional rectangle capture/reconciliation
-> optional Bool2d capture -> VoidContext-ready. Rectangle capture loops host and
opening probes, checks signed-permutation frame compatibility and reconciles
against the actual meshed opening volume. Bool2d capture must retain original
host-profile recovery, projected opening footprints and residual selection.
Do not memoize a prior probe merely because a later probe uses the same ID:
existing callbacks may mutate source/router state and the current program may
intentionally re-evaluate it. Any new memoization needs a separate qualified
semantic cache policy.

After admission, `ReadyVoidContext` owns classified raw/merged cutters, frames,
ParamRectCut and Bool2dCut data, with explicit source/host frame contracts. Cutter
meshes are evaluated runtime geometry, not a shortcut source plan. No evaluator
needs a decoder or callback once these captures exist. Existing f64 origin/RTC
relativization, direction, world-frame fast path and multi-frame parts survive.

Meaningful gates: existing program opening-policy tests; multibody openings,
rotated wall/window and local-origin tests; disconnected/overlapping openings;
Reference-only suppression and malformed representation controls; actual window
fixtures with positive cut volume/holes; matched far-world/mm/rotated placement.
Require classifier counts/host records in addition to geometry, and compare
recording versus quiet residual behavior. Synthetic invariants remain labeled
synthetic rather than real-exporter evidence.

## Layer 3: opening application and rollback become numerical/effect operations

Targets: `router/voids/{mod,staged,batch_cutter,bool2d_path}.rs`,
`bool2d_path/footprint.rs`, prism/correction helpers, rect-fast and telemetry
transaction adapters. A ready numerical operation consumes host handle plus
ReadyVoidContext and explicit quality/frame/configuration values. The existing
order is retained: parametric rectangle attempt; staged Bool2d; origin-aware
relativization; ordinary exact/batched/diagonal/nonrectangular routes and their
current numerical recovery. Never apply source boolean roof planes again as
unbounded opening clips.

Existing `staged.rs::HostAttempt` snapshots exactly host CSG failures,
HostOpeningDiagnostic, consumed flag and rect counters; telemetry has its own
transaction. Replace retained borrowed transaction guards with owned provisional
EffectSet/attempt state. Rejection or unwind discards only that attempt's effects,
preserving earlier hosts and admitted source evidence. An accepted mixed result
commits correction, topology-gate, consumed-host and telemetry effects once at the
same reached return point. Keep mandatory prism-correction refusal before an
unnecessary exact residual cut. Keep current topology-defect floor/growth and
engulf/triangle-retention/no-overlap/unchanged policies; do not tune thresholds
inside this ownership migration.

Decoder-free helpers should return owned NumericalOutcome {geometry, semantic
losses, host changes, telemetry}, with named attempt/rollback domains. This is not
permission to drain process-global census or processor logs at each step.
Exact-kernel ElementState travels through the enclosing product polls and is
never restarted on speculative retries or nested children.

Meaningful gates: staged transaction tests including rejected mixed route and
prior unrelated host diagnostics; cut-effect-count tests; consumed-host cases;
prism deferral/topology correction; all current geometry paths on default/native
and WASM flags. Check pending caller diagnostics and caught panic restoration.

## Layer 4: layer slicing joins the host/opening program

Targets: `router/layers.rs`, new `program/layers/{source,control,execute}.rs`,
material-layer index services, and the layered entry gates in router processing.
Own a small LayerAdmission result from immutable LayerBuildup plus source-derived
eligibility. Preserve Select::Body's first contributing representation test;
ordinary ProductProgram uses Meshed and must not silently replace this policy.
One item, no mapping and identity Position eligibility remains distinct from the
static `is_sliceable` class assignment. The boolean FirstOperand identity walk is
iterative and cycle guarded, with no new small depth cap.

The exact reached order is buildup kind/layer count -> single-unshifted-item
eligibility -> merge thin layers -> merged host WITH openings -> empty-host test
-> late placement/plane admission using actual base.origin -> slicing.
Do not parse placement planes before host execution: unresolved source and
extension mutation would move observable errors. ReadyLayerSlice owns visual
layers (material IDs, thicknesses, dominating-material choices), f64 planes and
frame stamp plus host resource handle. The evaluator keeps the original uncapped
remainder-carving sequence and error recovery: if a split fails, keep remaining
geometry with the current layer and stop carving. No finished slab meshes are
stored as source plans.

Gateway assembly retains <2-submesh fallback, layer hygiene and ordered skip
reasons. Geometry class3 alone is never evidence of a slice. Real slices carry
material_id rather than geometry_item_id; air-gap sentinel0 becomes None. Do not
change layer material/style resolution precedence or newly cap interfaces.

Meaningful gates: actual canonical three-layer fixture with materials200/201/200,
air-gap200/None/200 and two-item class3 unsliced geometry40/48; existing thin-layer,
cycle, large placement and opening-cut layered-wall tests. Volume sum, visible
skin, no internal cap ghost faces, order/material association and independent
placement/RTC invariants accompany field parity. Repeat via public owned driver;
the existing borrowed API remains a synchronous view over this same core.

## Layer 5: real presentation admission and assembly

Targets: processing `element/{session,session_work,session_accept,assembly_types,
assembly_submeshes,assembly_fallback,element_color}.rs`, `element_mesh_build.rs`
and canonical style/indexed-colour helpers. Mesh assembly is not yet decoder-free:
submesh/representation-map style ancestry and fallback indexed colour still read
the decoder. Admit those effective values at the original post-geometry lookup
points, after extension mutations, into `ReadyPresentation`.

The owned presentation packet contains ordered geometry handles, validated
source-item versus material provenance, class, effective RGBA/shading/material
name, immutable texture attachment and UV channel, full metadata/layer/property
values or shared immutable handles, exact frame/origin/local-bounds/transform,
tolerance/weld/order/hash policy and template/occurrence intent. Reuse existing
canonical precedence helpers during admission; do not recreate a color/style
resolver in a program-specific path. Assembly operates on that payload without
a decoder/router and preserves weld/normal/UV seam order, source/instance IDs,
geometry hash exclusions for type geometry, closure/volume/AABB and metadata.

ReadyPresentation must not trigger a second load or per-product clone of model
maps. Snapshot handles remain Arc-owned and lifecycle validated. Actual source
bundle authentication is supplied by its separate owner when integrated; a
context token alone is not byte/index proof. Preserve public borrowed structure
shape and synchronous signatures, fallible owned lifecycle errors, custom nested
same/mixed/ancestor router composition and scoped worker decoder borrowing.

## Effect identities and when publication occurs

A definition ID (source item or constructor) is not an execution occurrence.
Use an internal checked OccurrenceKey: model/context/source epoch, product
session/attempt, representation ordinal, item ordinal and nested role/mapping/
opening path ordinal. Add command sequence, actual registry emitter/generation
and input resource slot generations to a work identity. Derive runtime owner
stamps from the existing decoder/router leases; do not stamp a custom lowering
hook as a builtin solely because its IFC type matches a builtin family.

Effect receipts have their own checked identity and one owner/commit record:
source diagnostic/unsupported claim (with current per-router versus pass-shared
scope), local/shared cache publication, provisional template mark, host opening
classification/consumed state, layer result diagnostics, boolean records and
presentation/hash/instance append. Duplicate execution/acceptance cannot reapply
any of these. Wrong owner/emitter/context/payload returns the intact packet before
assembly, cache effects or charges. Future finer packets must preserve that
existing rejection behavior, rather than consuming a valid outstanding ticket.

Preserve reached effects: a completed valid mapped cache entry is published at
its original source-complete point before placement, even if a later branch
fails; a failed dependent template mark rolls back. Do not defer all effects to
outer accept or rewind independently completed cache entries. A speculative
opening/group attempt has explicitly narrower rollback domains. Per-operation
source/evaluation reports need a consumer boundary, not unconditional replay:
restore existing caller TLS, retain ordered evidence on error, and do not drain
another product's pending reports. Global CSG census remains a public aggregator;
optional scoped measurement is not occurrence-attributed truth unless actually
captured at its record site.

Runtime configuration is captured at each historically reached operation. Do not
freeze an entire router configuration before a custom callback that may validly
change the effective later settings. Quality/frame/order changes still refresh
trusted generations and preserve caller scopes. No TLS/lease guard survives a
reply wait; immutable snapshots and owned budget/diagnostic state do.

## Coherent implementation and qualification order

1. Common operation/result slots and owned effect/attempt identities; wire them
   to the existing internal ProductState packet protocol while keeping synchronous
   drivers. Establish once-only dispatch/accept/effect tests using actual geometry.
2. Boolean/CSG control plus specialized half-space/group/void-operand admissions
   and existing decoder-free numerical plans, deleting replaced borrowed Driver.
3. Opening classification/capture child programs, then application/transaction
   operations as one complete host pipeline, retaining all recovery branches.
4. Layer control/source eligibility/planes and numerical slicing on that host
   pipeline; class/provenance/diagnostic gates close alongside it.
5. Late presentation/style admission followed by decoder-free assembly; native,
   browser, appearance and export consumers stay on the same canonical driver.
6. Integrate separately reviewed coherent-source and resource accounts at these
   actual boundaries. ProgramStop is distinct from historical source loss/empty/
   retry and cannot be swallowed in mapping/boolean/opening/layer fallback. Strict
   unsupported coverage remains explicit; no heap/process bound is inferred.
7. Qualify the whole migrated default path, not only private ready-operation
   tests: all workspace/Clippy/WASM/Python/public API consumers, real acquired
   texture/mapped/georef/opening fixtures, layer and annotation positive witnesses,
   full consumer scene comparison plus input/option/lifecycle identities. Run all
   heavy work through the mandatory fleet launcher; preserve real refusals and
   unavailable coverage. End-to-end base/candidate worker-pool measurements and
   output identity are separate from correctness; no speed claim from this plan.

Review boundaries should follow the complete dependent branches above, not a
collection of unused plan types. Every numerical extraction is consumed by the
actual default path in the same change. Keep new production modules/functions
under existing size bounds without raising allowances. A final inventory must
show no builtin evaluation rereads source, no decoder-based presentation assembly,
no replaced control path left as fallback, and every retained source-reading
custom boundary explicitly leased and preserved. That is the completion criterion,
not the existence of a new ProductProgram name or an eager graph example.
