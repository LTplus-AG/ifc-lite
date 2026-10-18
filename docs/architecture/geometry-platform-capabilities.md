<!-- SPDX-License-Identifier: MPL-2.0 -->
# Geometry platform: capability preservation ledger

Inventory date: 2026-10-18. Baseline inspected: `8acd0715a`.
Design: [complementary kernels](../../tools/smlib-evaluation/implementation-design.md).

This ledger records existing contracts that the geometry-platform migration
must preserve. A source or test listed here is available evidence, not a claim
that it has been run against the new platform. No existing capability is
qualified for replacement merely because an operation name exists in SMLib.
The initial implementation is infrastructure; each affected row stays open
until a run receipt identifies the commit, artifact, platform, fixture, assertion
and result. Missing downloaded fixtures are skips, never preservation evidence.
Implemented infrastructure and separate run receipts are tracked in
[foundation status](geometry-platform-foundation.md); these do not close the
whole-platform migration rows.

## Ownership and acceptance rules

Rust continues to own IFC interpretation, representation selection, frames,
appearance resolution, diagnostics and execution policy. The exact engine
remains a permanent mathematical engine. SMLib adds retained curved BRep
evaluation. Both produce revisioned results for shared consumers. Engine choice
is recorded before execution; an exact request cannot become tolerant geometry
after failure. Explicit mesh inputs remain valid representations.

An acceptance receipt distinguishes:

1. Unchanged existing behavior, supported by base-versus-branch execution.
2. Deliberately improved behavior, supported by an independent analytic result,
   admitted oracle or real-model evidence and a recorded behavior decision.
3. Newly added capability, supported by its own validation and target coverage.

Every row below is **open for migrated execution**. Existing regressions remain
tests; neither new topology nor a different triangle count alone proves a fix.

## Numerical and authored geometry contracts

| Contract | Current owner and concrete evidence available | Target owner and remaining proof |
| --- | --- | --- |
| Exact signs for explicit binary coordinates and symbolic line-plane / three-plane intersections | `rust/geometry/src/kernel/mod.rs`, `predicates`, `interval`, `fixed`, `rational`; `rust/geometry/tests/exact_predicate_determinism.rs` | Retained exact engine. Preserve sign decisions and denominator conventions; run tier/oracle and cross-platform tests without weakening them. BRep tolerance is a separate guarantee. |
| Current mesh normalization and numerical budgets | `rust/geometry/src/kernel/mesh_bridge.rs`, `budget.rs`; `kernel/budget_tests.rs`; CSG property/quality/epsilon-scale tests in `rust/geometry/tests/` | Explicit evaluation/conversion policy. Preserve existing snap, reconciliation, timeout/budget diagnostics and mesh behavior for compatibility requests. Exact arithmetic does not make snapping or f32 output lossless. |
| Exact predicates outside CSG | `rust/processing/src/pdf_vector/curve_hulls.rs`, `stroke_topology.rs`, `strokes.rs`; analytic `topology_interval.rs`; appearance transfer uses kernel BVH | Keep these consumers supported. Compile/test the whole workspace before deleting/reorganizing kernel modules; numerical topology guarantees must survive a CSG orchestration change. |
| Authored extrusion parameters and nominal quantities | `rust/processing/src/analytic_export/extrusion_definitions.rs`; `analytic_extrusions.rs`, `analytic_quantities.rs`, `analytic_definitions.rs` under processing tests | Authored document plus compatibility adapters. Keep raw IFC file units, separate profile/solid positions and quantities in squared/cubed file units. Net cut volume must be separately named. |
| Reusable swept-disk sources and occurrence matrices | `analytic_export/definitions.rs`, `walk_tests.rs`; `analytic_swept_disk.rs`; Python `analytic_definitions.rs`, `swept_disks.rs` | Definition/occurrence model. Preserve direct versus ordered representation-map contexts, model SHA/schema/unit-scale bits, occurrence ordinals, `mapping_path`, `source_modified`, status and nullable transforms. |
| Existing analytic coordinate contract | Definitions say `source_units=ifc_file_length_units`, `world_units=m`, Z-up absolute IFC world; `world_from_source` is column-major f64 including units/object/mapping transforms | Keep authored storage lossless relative to current source types; adapters retain these public values. Test millimetre files, nonuniform mapped transforms, nested maps and invalid placements; do not silently publish normalized metres as source parameters. |
| Tessellation quality and small-cut policy | `TessellationQuality`, processing request/options, `packages/geometry/src/perf-flags.test.ts`, Python `parse_quality`; worker init | Preserve five quality labels, default behavior, explicit invalid-label errors, and independent `skipSmallCuts` semantics. New BRep chord/angle options need an explicit mapping; requested tolerance is not a certified error bound. |

## Input-family coverage

The authoritative existing built-in dispatch is
`rust/geometry/src/router/processor_registry.rs` (the `processor_families!`
declaration, which generates aliases, `ConstructionFamily` and creation). It has
21 processor slots, including several aliases. Public processor overrides are
also supported; the new service must retain an equivalent extension contract
or introduce an explicit versioned API change. This is the inspected baseline
inventory, not a claim that every legal IFC entity instance is supported.

### Implemented construction layer; qualification remains open

`rust/geometry/src/construction/` now compiles explicit raw representation-item
roots into a flat typed DAG with ordered solid/solid booleans and CSG dependencies.
Owned production lowering covers nineteen registry families, including the previous ten plus
advanced BRep, B-spline surfaces, both surface-model families, structural faces and
edges, sectioned solids, alignment and linear extrusion surfaces. Registered aliases
retain the same dispatch policy. The
production processor entry points use the same lower/evaluate seams. Canonical
solid/solid execution shares `SolidBooleanPlan` and the existing exact kernel.
Canonical boolean/CSG control now runs the demand-driven owned continuation
described below; this is distinct from optional eager batch compilation.

Repeated roots retain their ordered occurrence indices. Definitions are shared
within a dispatch role; intermediate mesh ownership moves at the last consumer,
with clones for additional consumers. Root custom registrations remain explicit
requirements while boolean operands use the existing built-in-only dispatch policy.
The iterative compiler reports cycles and refuses any batch with unresolved roots.

This graph is opt-in, eagerly admits all reachable dependencies and does not replace
canonical element assembly. Its independent fixed node/work limits differ from
legacy contextual operand budgets; root scheduling, source payload allocation,
numerical effort and process memory are separate bounds. Mapped/product semantics
and external openings remain outside this batch. Its conditional source-error recovery, half-space/grouped-cut policies and contextual
budget equivalence remain unqualified against canonical execution.

Coordinates remain file-unit construction coordinates with constructor Position
applied during evaluation; revolution angles resolve to radians. Router scale/RTC
policy and appearance remain outside this contract. Sampled profiles/directrices
and production f32 coordinate admission remain approximation boundaries. The batch
does not recover survey-coordinate detail or establish retained analytic surfaces.
Standalone/base with-voids construction retains the historical Outer-shell
behavior. Operation operands now own and evaluate ordered inner-shell plans for
both faceted and advanced BReps. Their eager source/unit admission remains
different from production's conditional admission and needs full qualification.

Current production extraction also owns half-space planes, bounded-prism inputs,
void-shell construction and polygonal candidate snapshots, and separates grouped
cut numerics from decoding. Canonical owned boolean/CSG control-flow execution
is now implemented. Separate
[cutter/control receipts](evidence/geometry-platform-cutters/) retain the prior
stage's tested scope and limits; historical receipts below remain unchanged.
Separate [continuation receipts](evidence/geometry-platform-continuations/)
record their pinned continuation-stage scope and remaining limits, not the later
work-boundary corrections.

Successful evaluations carry semantic boolean losses per unique requested root
and fresh failures attributed to executed source instructions. Structured errors own
prior observed failures, root/item context and durable reports. Face/curve reports
survive thread transfer without consuming caller TLS; decoder refusal IDs are a
cumulative snapshot. Product occurrence attribution and complete report parity
remain explicit acceptance requirements.

These are implemented boundaries, not completed preservation verdicts. Existing
[foundation](evidence/geometry-platform-foundation/),
[execution](evidence/geometry-platform-execution/) and
[phase](evidence/geometry-platform-phases/) receipts retain their original scope.
Separate [construction-layer receipts](evidence/geometry-platform-construction/)
retain the prior constructor-stage tests and canonical model comparisons. They do
not qualify the extended constructor families or operation DAG. New operation-layer
receipts now live under [operation evidence](evidence/geometry-platform-operations/).
The [constructor-family layer](evidence/geometry-platform-families/) records the
expanded nineteen-family scope and demand-driven diagnostic ownership. These
receipts do not qualify complete migrated execution; every family row below stays open.

### Canonical continuation implementation; complete qualification remains open

`processors/boolean/continuation.rs`, `continuation_state.rs` and
`continuation_batch.rs` now own canonical boolean/CSG execution. Owned frames
retain hosts, ordered spines, pending operands, depth, `solo_step`, empty-loss
flags and provisional marks. Decoder reads occur at reached transitions;
`step.rs` splits admission from shared owned numerical execution. Recursive
boolean/CSG operand evaluation is removed. Non-recursive leaf admission stays
in `operand.rs`; `csg_root.rs` owns wrapper root resolution.

The implementation retains conditional empty-host/operator/kept-side decisions,
operation-specific unreadable-second recovery, conditional WithVoids shells,
CSG depth resets and provisional group deferral. Active-path cleanup preserves
caller ancestors; monotonic operand visits survive errors/deferrals. These are
implemented mechanisms requiring preservation proof, not claims that every
capability below is qualified. In particular, full product/mapping traversal,
external openings, presentation/consumer migration and retained-kernel integration
remain pending.

The optional eager `ConstructionBatch` has independent graph limits and
source-admission timing; it is not the canonical continuation contract. New
continuation receipts live under
[canonical continuation evidence](evidence/geometry-platform-continuations/). Tests
include `continuation_tests.rs`, Boolean step/chain tests and CSG-root tests.
Require dynamic evidence for dormant malformed operands, empty/unknown-operator
branches, kept-side contour skips, ordered shell failures, group deferral, CSG
cycles/depth resets, shared-DAG exhaustion and exact report multiplicity. Add
broader real-model mesh/report/frame comparisons and cross-target/resource qualification.
No earlier receipt is promoted to proof of this control-flow replacement.

The recorded reference-walk check passes for its pinned extraction, but its recursive call-graph
analysis does not follow the explicit continuation queue. Dynamic guard safety,
termination, path-scope correctness and refusal reporting remain independent
acceptance requirements.

| Existing family | Current owner / representative evidence | Required preservation |
| --- | --- | --- |
| `IfcExtrudedAreaSolid`, `IfcExtrudedAreaSolidTapered` | `rust/geometry/src/processors/`; `rust/processing/tests/analytic_extrusions.rs`, `analytic_mesh_oracle.rs`; `rust/geometry/tests/issue_7685_profile_holes.rs`, `issue_964_arbitrary_profile_voids.rs` | Profile frames, holes, supported profile families, taper correspondence, extrusion direction and placement. Keep analytic source export as well as rendered shape. |
| `IfcTriangulatedFaceSet`, `IfcTriangulatedIrregularNetwork`, `IfcPolygonalFaceSet` | Built-in registry and corresponding processors; indexed-colour/texture tests below | Explicit meshes remain first class. Preserve indices, holes, open surfaces, UVs and palette bindings without forced solid reconstruction. |
| `IfcFacetedBrep`, `IfcFacetedBrepWithVoids` | Faceted processor; `processor_registry_tests.rs`; geometry correctness harness | Preserve outer/inner shell semantics, cavities and manifold classifications. A faceted BRep conversion needs an explicit validation result. |
| `IfcBooleanResult`, `IfcBooleanClippingResult`, `IfcCsgSolid`, `IfcBlock`, `IfcSphere` | Boolean processors, `csg/`, `kernel/`; `csg_property_test.rs`, `bath_csg_solid_test.rs`, half-space regression tests | Preserve exact-polyhedral defaults, operation order, empty/disconnected results and diagnostics. Half-space agreement/bounds cannot be replaced by arbitrary giant cutters. |
| `IfcSweptDiskSolid`, `IfcRevolvedAreaSolid` | Swept-disk/revolved processors; analytic swept-disk tests; `swept_disk_trimmed_line.ifc` and `swept_disk_composite_arc_crankbar.ifc` fixtures | Hollow radii, trimmed domains, directrix continuity, sweep frame and analytic provenance. A generic pipe constructor does not certify IFC semantics. |
| `IfcSurfaceCurveSweptAreaSolid`, `IfcFixedReferenceSweptAreaSolid` | Swept-area processor; `issue_1485_duct_elbow_surface_curve_swept.rs`, `issue_3353_sweep_261_classification_tear.rs` | Preserve reference-surface/fixed-direction frames, discontinuities and supported parameter domains. |
| `IfcSectionedSolidHorizontal`, `IfcAlignment` | Sectioned/alignment processors; `issue_7584_viadotto_course_profile.rs`; placement/schema regressions | Preserve infrastructure semantics, station/profile placement and curve-only outputs; do not infer coverage from SMLib skin/sweep APIs. |
| `IfcAdvancedBrep`, `IfcAdvancedBrepWithVoids`, B-spline/rational surfaces | Advanced-BRep and advanced-face processors; correctness harness; `issue_5698_advanced_brep_rtc_detection.rs` | Retained surfaces may improve fidelity, but every existing admitted family needs trims/orientation/seam/pole/cavity proof. Current smoke tests do not establish direct IFC lowering coverage. |
| `IfcShellBasedSurfaceModel`, `IfcFaceBasedSurfaceModel`, `IfcFaceSurface`, `IfcAdvancedFace` | Surface/face processors; harness surface-model fixtures | Supported open geometry stays open. Do not manufacture solid volume or hide failed faces behind a closed-body flag. |
| `IfcEdge`, `IfcEdgeCurve`, `IfcOrientedEdge`, `IfcSurfaceOfLinearExtrusion` | Edge/surface processors, registry tests; `issue_7688_surface_of_linear_extrusion.rs` | Preserve edge sense, curves and supported surface geometry independently of solid admission. |
| Mapped items and type-library geometry | Router `mapped_item.rs`, `instancing.rs`; `mapped_walks_tests.rs`; processing `issue_1985_mapped_item_transform.rs`, `mapped_operator_precision.rs`; `element.rs` | Definitions share geometry while occurrences retain transforms/presentation. Preserve the viewer/export distinction in `TypeGeometryMode`; exports must not duplicate type geometry. |

## Product assembly, appearance and editing

### Owned product session; synchronous work qualification pending

Canonical `produce_element_meshes` now synchronously drives a private owned
`element/session.rs` session. Its job entity/metadata, selected strategy, owned
map list, typed attempts, geometry/instances and hasher survive between reached
stages. The old execution orchestrator is deleted; shared `AssemblyJob`-based
presentation remains canonical. Construction performs reached strategy planning
synchronously. `Primary`, `VoidedParts`, `PlainParts` and `TypeMaps` preserve
terminal annotation refusal, instance-only output and consumed-host success.

Owned exact-budget `ElementState` and degenerate-drop state install counters and
cap snapshots under short-lived `!Send` guards for each synchronous slice, save
progress on unwind and restore ambient caller state. The owned states can move;
an executing router/cache/diagnostic owner cannot. Triangle-order configuration
is scoped by RAII. Processing is a real consumer of the new public budget API.

CSG diagnostics keep their original abandoned-primary retry drain and single final
drain, preserving processor grouping and loss order; no per-poll drain occurs.
The final drain intentionally observes restored caller triangle-order mode;
normal slices retain the product's callback-mutated mode between polls.
The private session now issues typed synchronous work and separately accepts
its reply before assembly. Planning obtains a temporary reservation; first
execution or finish binds exclusive decoder/router reservations through
publication. Stable identities stay inline and shared reservation state is lazy.
Validated synchronous work may commit trusted callback cache/unit/configuration
mutations against the same live owners. External configuration changes while a
reply waits invalidate it, and acceptance cannot refresh generations from reply
data. Replaced or dropped owners always reject. Ordinary router capabilities
remain thread-bound. Canonical lexical admission searches all live ancestors and
strictly reserves each unmatched owner half. An explicit decoder source scope
also permits a scoped worker to borrow the actual mutable decoder, create its
own compatible router, produce a canonical child and join before parent resume.
Source authority expires with ancestor work and is absent while replies wait;
independent resumable siblings remain exclusive. This propagates no budget,
pending-diagnostic or census TLS beyond existing worker-local behavior. Owner/configuration, session/sequence/stage, payload, contextual
emitter and captured registry identities are checked before acceptance. Rejected
packets are returned unconsumed. Pending TLS reports are scoped and restored;
full router diagnostics and cache effects remain with the leased owner. Sparse
actual-entry capture omits direct constructors and contextual/factory paths
outside registry hooks, so it does not establish complete provenance. The
borrowed public producer remains supported. The owned producer now holds one
immutable context snapshot, with checked load/source-epoch/revision identity and
typed source-expiry rejection. Native chunks, browser batches and appearance
consume these snapshots. This lifecycle identity does not authenticate supplied
decoder bytes/indexes or define a transport protocol. There is no public async/poll/reply/cancel product
API. Dormant source-transfer tests do not qualify live router migration.

[Product receipts](evidence/geometry-platform-products/) record native/WASM
checks, six matching geometry fingerprints and sampled native RSS. Full
presentation equivalence and latency non-regression remain unqualified;
historical receipts keep their original scope. The
[work-boundary receipts](evidence/geometry-platform-work/) retain their historical
ownership-layer source. The
[corrected mapping/context candidate](evidence/geometry-platform-context-restored/)
has fresh ABI, browser, Python, selected interchange and 44 structured native
scene comparisons. Its workspace attempt stopped at a new test's event-count
assumption; an independent baseline comparison proves the corrected contract.
The [final context snapshot](evidence/geometry-platform-context-final/) restores
API descriptions and corrects that test, with fresh consumer checks and a
passing full native workspace/all-target Clippy run. Positive layer witnesses
cover both public Rust producers and actual WASM batches. Six interleaved
worker-pool model comparisons preserve geometry fingerprints; shared-host
timing is unqualified and the heavy model's slower execution and higher peak
memory require controlled profiling. Full performance qualification remains
open. Separate heavy-model comparisons match all four native modes, including
instances and deferred colors; final rehash and execution-record audit remain
pending after fleet refusal. Synthetic annotation cases add positive fill,
hole-area and placement invariants, without claiming exporter fill coverage.
Mapped control now owns
its traversal frames; reached admission and numerical execution still share
synchronous steps. Complete product/opening source commands, diagnostic/cache
effects, authenticated source bundles, frame acceptance, external lifecycle
handling, retained integration and complete consumer migration remain open. All capability
rows below retain their preservation evidence requirements. See the
[current product-session contract](geometry-platform-product-session.md).

| Contract | Current owner and available evidence | Target owner and remaining proof |
| --- | --- | --- |
| Canonical element assembly | `rust/processing/src/element.rs`, owned `element/session*.rs`, shared assembly and native `processor`/browser `processGeometryBatch` callers | One owned synchronous product-control/assembly path; finer command/reply migration remains open. Preserve representation gate, alignment exception, per-item errors, void-aware submeshes, colors and diagnostics in native and browser. |
| Host openings and opening filter | Processing void index and geometry `router/voids`; `issue_5410_redundant_opening_on_voided_profile.rs`, `issue_5739_local_frame_voided_wall.rs`, `opening_filter_ignore_opaque.rs`; overlapping-opening fixture in processing tests | Derived result key includes host base revision, cutters, relative placements and policy. Distinct openings on mapped occurrences must not modify shared source bodies. Preserve “cut skipped/failed” reporting. |
| Colors, materials and finishes | `rust/processing/src/style`, `element_color.rs`; `styling_parity.rs`, `styling_default_colors.rs`, `issue_5409_opening_display_colour.rs` | Shared Rust style authority. Preserve SurfaceColour versus shading color, alpha, per-item and indexed per-face palettes, material alternation and finish metadata. New split/generated faces require attributable material policy. |
| Textures and UVs | `MeshProductionContext.texture_index`; `issue_961_textures.rs`, `issue_1781_image_textures.rs`; geometry worker/style-finish tests; `packages/renderer/src/appearance-uvs.test.ts` | Revisioned face/triangle bindings and image lifetime. Test cuts, transforms, instancing and native/browser export with UV seams; a solid-level material is insufficient. |
| Appearance edits on shared type bodies | `rust/processing/src/appearance/evaluated_replacement.rs`, `evaluated_tests.rs`, `evaluated_mask_tests.rs`, `transfer_acceptance_tests.rs`; viewer appearance WASM tests | Occurrence-owned derived geometry and revision invalidation. Preserve shared-body copy behavior, layer associations, face-mask lineage and evaluated appearance on reopen. |
| Overlay edits, undo/redo and new entities | Viewer mutation slices, `packages/create/src/in-store`; `mutation-element-profile.wasm.test.ts`, `mutation-profile-fidelity.test.ts`, `placement-frame.overlay.test.ts` | Durable document descriptions replay committed overlays; undo selects the correct revision. Worker handles cannot be the durable source. Prove edits invalidate mesh, bounds, queries and exports together. |
| Federation and identity | `FederationRegistry`, `modelSlice.resolveGlobalIdFromModels`; `federation-overlay-publication.test.ts`, renderer registry tests, loader federated offset/cancel tests | Model-local source IDs plus explicit occurrence identity. Resolve edited overlay IDs through store-backed resolver; preserve single-model `globalId===expressId` and N-model behavior. No new offset arithmetic. |
| One canonical model ingest | `useIfcLoader.loadFile`; federation wrapper; loader IFCX/GLB/federation tests | Document admission must be reached by primary and federated loads, cache hits and all formats. Kernel integration cannot create a second federated load path. |

## Frames, consumers and exchange

| Contract | Current owner and available evidence | Target owner and remaining proof |
| --- | --- | --- |
| RTC and georeference precision | Processing frame/georeferencing; geometry placement chain; `site_local_frame_rotation.rs`, `issue_900_georeferencing_metadata.rs`, `georef_map_conversion_math.rs`, geometry `streaming_rtc_early_site_late_placement.rs` | f64 world/occurrence transforms and local numerical work. Rebase before f32 extraction and restore world frame once; keep site/building/representation placement rules. Test survey coordinates, late placements and local models. |
| Viewer axis and CPU/GPU placement | Geometry bridge/coordinate handling; `rtc-frame-every-path.test.ts`, `world-frame.test.ts`, `real-rtc-anchor.test.ts`; renderer instanced/RTE tests | Explicit frame adapters retain IFC Z-up versus viewer Y-up. Bounds, picking, rendering and analysis must agree after model repositioning. |
| Geometry hashes and cache identity | Processing `GeometryHashConfig`; geometry fingerprint/hash tests; cache sections | Evaluation policy, frame-independent source/operation revisions and tessellation settings belong in cache identity. Preserve RTC-invariant comparison and reject stale kernels/results after restart or edits. |
| Mesh and exact solid clash | `rust/clash`, `packages/clash/src/engine-ts`, `engine-wasm`, geometry `clash_solid.rs`; `clash_intersection_oracle.rs`, `clash_intersection_real_model.rs`, clash world-frame/depth-provenance/differential tests | Existing classification, enclosure/contact/depth/provenance and exact intersection-solid semantics continue. BRep queries add a named policy; do not silently alter thresholds or report stale uncut bodies. |
| Zone splitting | `rust/geometry/src/zone_split.rs`, `zone_split_tests.rs`; viewer split worker/client tests | Preserve exact polyhedral splitting, volume and occurrence placement; replay/invalidate derived pieces after source edits. |
| Sections and drawings | `packages/drawing-2d/src/section-cutter.ts`, polygon builder, GPU cutter; section/profile tests; processing symbolic and PDF-vector tests | Preserve arbitrary planes, flipped drawing orientation, entity keys, loop assembly, projected geometry and annotations. BRep plane intersections alone do not replace drafting policy. |
| Symbolic/annotation geometry | Processing symbolic modules; `symbolic_golden.rs`, `issue_843_symbolic_parity.rs`, `issue_4706_symbolic_shares_the_mesh_frame.rs`, `issue_symbolic_finiteness_followup.rs` | Preserve text/curves/symbols, nonfinite refusal, metadata and common frame. Solid-only service interfaces must not discard these outputs. |
| USDA mesh export | `rust/export/src/usd.rs`, `usd/instance.rs`, `usd/tests.rs`; processing frame restoration; CLI `export-usd.test.ts` | Preserve hierarchy, IFC metadata, materials, instance prototypes, Z-up metres, local `point3f` plus double placement and one `/World` frame restore. Keep no-render-geometry refusal. Retained BRep is additional qualified representation. |
| IFCX composition and geometry | `packages/ifcx/src/geometry-extractor.ts`, traversal, layer stack and writer; geometry-extractor, inherit-precedence, tombstones, layer-stack, georeference, appearance-wire tests | Admit geometry after composition. Preserve inherited visibility/color, path attribution, transforms, alias deduplication and distinct real instances. NVIDIA BrepArray requires an explicit format contract and synchronized mesh presentation. |
| Other published exports | `rust/export`, export goldens; TS export roundtrip and georef-closure tests; API-surface snapshot and docs samples | Migrate GLB/geometry-data/STEP and other existing consumers without narrowing supported shape, appearance or coordinate behavior. Changed output needs format-specific evidence, not one USD success. |

## Runtime, failures and distribution

| Contract | Current owner and available evidence | Target owner and remaining proof |
| --- | --- | --- |
| Malformed references terminate and report | Shared `ifc_lite_core::limits`; representation `walk_tests.rs`, boolean `chain_cycle_tests.rs`, `continuation_tests.rs`, profile `curve_fanout_tests.rs`; `processors/boolean/operand.rs` carries the monotonic 1024-entry work budget and canonical continuation transitions charge it | Iterative document planning with pure-definition memoization and path-aware accumulating walks. Preserve valid DAG multiplicity; test cycles, deep acyclic chains and fanout separately. A visited set alone is insufficient. Preserve diagnostics as well as bounds. |
| Exact operation effort bounds | `kernel/budget.rs`, budget tests and CSG census/failure drains | Keep numerical work budgets separate from file-reference budgets and worker deadlines. No partial shape may be labeled complete after a budget trips. |
| Browser init and restart | `geometry-worker-init.ts`; `geometry-worker-reinit.test.ts`, `geometry-parallel-hung-job.test.ts`, `hung-job-recovery.test.ts` | Restart replays WASM location/init, mergeLayers, instancing, hash tolerance, quality and skipSmallCuts before stream messages. New kernel settings and epochs join this same protocol. |
| Load filtering, cancellation and recovery | `geometry-parallel-options.ts`; streaming, stall-phase, heartbeat, abort/hung-job tests; viewer loader cancellation tests | Preserve visibility/type filtering, skip-type geometry, adaptive batches, memory-clamped worker count, tracing and progress. Hung skipping remains opt-in and reported via `skippedHungElements`; abort terminates silent workers. No hidden partial success. |
| WASM resources and exceptions | Geometry `.free()` ownership, prepass cache, disposal tests; wasm-runtime-trap/panic-forward tests | Deterministic release on completion, throw, abort and generator abandonment. Separate heaps require owned result copies; borrowed views cannot outlive calls/memory growth. Restart invalidates every stale handle/result. |
| Native parallelism | Processing `geometry_pool.rs`, FFI `run_in_pool`, Python `run_geometry` | Keep exact operations on existing Rust pool. SMLib process isolation and bounded scheduling must prove no shared-context race, unbounded children, deadlock or poisoned-worker reuse. |
| Embedded C FFI | `rust/ffi/src/lib.rs`, `tests.rs`; `server-release` mandatory unwind profile | Preserve `ifc_lite_parse`, `parse_ex`, `free`, pointer/length ownership, null/zero outputs on error and numeric error codes. A missing helper binary must have an actionable supported error; memory faults cannot be turned into Rust panic promises. |
| Python binding contracts | `rust/python/src/lib.rs`, `.pyi`, tests `test_bindings.py`, `test_golden.py`, `test_alignment_axes.py` | Preserve synchronous callable API/GIL release, quality/ID filtering, occurrence-only welded absolute Z-up metre data, LE f64 vertex/u32 face buffers, identity fields and exception behavior. Current implementation needs no subprocess; adding one is a distribution/support change requiring proof. |
| Native/browser/SDK/server surface | Published package indices, `scripts/api-surface.json`, wasm committed `.d.ts`, CLI help/docs and server processing consumers | Existing consumers continue compiling and executing against one semantics owner. Do not expose a new public API accidentally while building internal infrastructure. Regenerate bindings and version intentional API changes. |
| Asset and package closure | Geometry explicit `wasmUrls`; `packages/create-ifc-lite/test/published-worker-assets.test.ts`; `.github/workflows/python-wheels.yml` | Ship both WASM modules/glue/workers and native executable dependencies through actual packages. Verify bundlers, custom URLs, offline/self-hosted deployment and clean installations without developer checkouts/toolchains. No NVIDIA runtime/GPU or OpenUSD installation can become an accidental prerequisite. |
| Platform coverage | Python workflow: Linux x86_64 PR lane; full matrix adds Linux aarch64, macOS aarch64/x86_64, Windows x64 | Run install-and-use proof on all supported targets, including embedded FFI helper discovery. A Linux Emscripten/native build does not establish Windows/macOS binary or wheel closure. |

## Selected scene-preservation evidence

The [scene receipts](evidence/geometry-platform-scene/) qualify the historical
ownership-layer source recorded by its frozen manifest and reconstructible source
overlay. They do not qualify later mapping-continuation edits. One shared public
consumer, linked against the base and candidate, matches exact structured fields
in 44 fixture/mode comparisons across eleven sources. Every comparison also
matches an independent baseline repeat. Actual witnesses include UVs, decoded
texture pixels, external texture references, instances/templates, type geometry,
text, properties and deferred color events. Layer slices and symbolic fills are
not witnessed by this native corpus. Heavy full-scene and multiworker scene lanes
remain open. External URL equality does not establish image resolution.

Separate [IFCX/USD consumer receipts](../../tools/smlib-evaluation/scene-comparison/ifcx/)
record seven importer/composition comparisons and seven actual USD stage
comparisons with successful export/reopen checks. IFCX witnesses include real
property and PBR overlay opinions and point clouds. These IFCX samples produce no
UV/texture output or georeferencing object; they do not qualify those channels.
The USD samples produce no UV primvars or texture shaders, including textured
STEP inputs. Their equal absence does not establish texture preservation. These
lanes preserve the existing consumers; they do not add native IFCX import or a
second load path.

[Expanded WASM checks](evidence/geometry-platform-work/expanded-fixture-validation.json)
exercise all 223 existing contract cases with zero failures or skips on the same
historical candidate runtime, including real texture, layer/opening and remesh
cases. None of these receipts establishes complete platform preservation,
retained-engine activation, rendering/asset closure, or a performance win.

## Existing gates and the remaining qualification

Read live workflow files and the main ruleset when implementing; this document
does not freeze CI's required-context list. The inspected checks include:

- Root `pnpm typecheck` / `pnpm test` through Turbo, `cargo test --workspace`
  and workspace clippy with warnings denied. Python is a separate crate/wheel
  consumer and needs its own build and tests.
- `.github/workflows/determinism.yml`: exact predicates, geometry correctness
  snapshots, native mesh manifest, export goldens and wasm32 mesh manifest.
  Preserve the documented libm/trig manifest distinction. Deterministic sorting
  cannot turn numerically different BRep results into the same geometry.
- Existing reference-comparison gates: preserve admission, finite surface
  coverage and topology checks. A refused reference is not a passing comparison.
- `scripts/check-refwalk-guards.mjs`: lexical guard-presence check, with the
  documented cross-file blind spot. It passes the current continuation extraction,
  but explicit frame/work-queue transitions sit outside recursive call detection.
  It cannot prove correct guard scope, work charging or refusal reporting.
- `scripts/perf/probe.sh` and the performance ledger: base-versus-branch
  end-to-end worker-pool runs, parse/geometry/total, memory/artifact impact and
  output-identity statement. Retain both default FZK and opening-heavy ISSUE_129
  coverage; heavy CSG models matter where available.

Recorded SMLib feasibility evidence lives under
`tools/smlib-evaluation/evidence/`. It establishes a pinned native/core browser
build, synthetic operation cases and isolated browser instances. It does **not** establish migrated
IFC execution, full source-family coverage, exact/SMLib mixed-operation
correctness, retained face provenance, native concurrency safety, all-platform
packaging, memory bounds, performance improvement or browser BRep interchange.

Before cutover, attach receipts to every affected row, including cancellation,
recovery and repeated edits. Keep exact predicate/byte contracts distinct from
tolerance-based BRep comparisons. Existing compatibility outputs retain their
guarantees; new tolerant results carry representation, revision, frame,
conversion steps and validation status. Any unexplained capability loss leaves
the relevant row open and blocks replacing its current production owner.
