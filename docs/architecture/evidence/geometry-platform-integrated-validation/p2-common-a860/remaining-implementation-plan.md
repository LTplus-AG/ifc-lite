# Retained opening, layer and finite-halfspace implementation sequence

Design-only source scope: frozen `b98e6282a015a9cee7bd0ce2d562d1de9de0ea77` in root. Root had five dirty guard files when inspected; this plan uses immutable b98 Git objects and excludes those edits. Relevant SHA256 pins are below. No source edits, tests, builds or fleet submissions performed. This plan neither closes P2 nor qualifies any runtime route.

## Scope and actual blockers

P2 already carries typed Construction/Affine/Boolean operations through the original reached common Boolean program and processing-held pending batch/reply. Continue that machinery. Do not introduce another source walker, exact mesh fallback, caller-created receipt or authored recipe synthesized from a derived cutter.

Concrete currently closed gates:

- `boolean/retained.rs::retained_step` refuses every IfcHalfSpaceSolid subtype before the ordinary second-operand continuation.
- `PendingGeometryAttempt::retained` in processing/session_inner.rs admits textured/plain retained products and type maps, but rejects VoidedParts/VoidedSubmeshes. session_retained surfaces that as unsupported host-opening entry.
- `ProductRootAdapter::select_retained` explicitly clears its LayerControl; product requirements retain MaterialLayers and OpeningClosure.
- `inner_voids` stores HostPart Mesh, exact ReadyVoidContext, exact numerical ReadyOperation, and mesh Output. Its logical state/order is reusable; these payload types must be generalized.
- `OpeningAdapter` children finish into mesh parts and its control outputs mesh-based probe/classification/cut contexts. Bounds/mesh heuristics are not retained cutter authority.
- `LayerProgram::accept_host`, LayerPlaneRequest and ReadyLayerSlice store Mesh. LayerControl's child finishes via finish_parts/single_frame, and the slice numerics are mesh clipping.
- Remaining requirements are currently appended wholesale. Removing an enum item globally would falsely claim unrelated products/attempts complete.

Refusal remains an explicit development hold until the cases below are implemented and executed. It is not a completed preservation result.

## Smallest cohesive sequence

### 1. Add one certified finite clipping/splitting numerical seam

Introduce a typed common derived operation rather than a new RetainedConstruction variant for an invented IFC source:

- `ClipHalfspace { input: LogicalRetainedValue, admitted_plane, mode, optional_raw_boundary }` for finite host Difference/Intersection clipping.
- `SplitPlane { input, plane, interface_identity }` for the paired layer band/remainder operation, sharing one actual cut and two ordered output identities. This can share a numerical implementation with ClipHalfspace but must retain paired outputs and provenance.

Put raw admitted plane/boundary structs in a small geometry-owned retained clipping module. Include the reached source occurrence/key, source epoch/revision, raw plane placement, AgreementFlag, declared units, and for polygonally bounded cases original Position and ordered original boundary coefficients before any sampling. Extend RetainedOperationKind through explicit variants; keep physical derived output definitions LogicalRetainedDefinition::Operation. A domain-derived cutter is never described as an authored retained extrusion with a forged STEP identity.

Use processing's same pending transaction/ordered input Arc binding, and extend its target receipt projections with a sealed actual Clip/Split receipt. A multi-output split needs an operation output group under one original request, with all outputs validated before advancing, not a synthetic batch of unrelated constructions. Retain the input until both outputs and their boundary classification are accepted. Native and browser adapters consume the same issued operation and acceptance logic from the P3 seam.

The numerical implementation must first establish a conservative finite domain of the **actual input BRep in its local metre frame**. This cannot use display mesh bounds or just sampled vertices. Investigate the pinned SDK's bounding methods/control hulls and prove an enclosing domain for every admitted geometry class, including analytic extrema and rational weight assumptions. Bind any bound/envelope certificate to the actual input handle/domain and operation. Fail explicitly for an uncertified domain rather than guessing a margin.

Prefer a checked SDK plane-split/trim path if its exact ownership/topology/side semantics and generated-face ancestry can be established. Inspection so far found SmApiIntersectBrepWithPlane produces section curves, not a finished clipped solid; SmBrep::CutBreps consumes cutter Breps and has connected-face-set outputs. Neither declaration alone proves a usable clipping operation. Inspect implementation/status/cleanup before choosing it.

If a bounded numerical cutter is needed, derive its extent from that certified host domain in plane coordinates, with an explicit outward-rounding/tolerance policy. It must strictly cover only the relevant finite host domain; no fixed giant cutter. For a plain plane, construct a convex bounded clipping volume from the domain and requested side. For polygonally bounded halfspaces, intersect the plane side with the Position-oriented unbounded prism restricted to the host domain; retain the real polygon boundary and Position.Z independently of plane normal. Near-parallel cases require a mathematically valid bounded construction, not the existing sampled prism's heuristic base placement. This is an internal numerical operand with derived lineage, not a fake authored source.

No existing SDK opcode number/capability is allocated by this plan. Add them coherently after the numerical contract is fixed; ABI/capability signals implementation only. Receipt identity must include actual ordered input, original plane/boundary, domain certificate, side/mode, actual output frame/outcomes, split interface identity and source/created-face ancestry. Source inputs remain unchanged; copy failures use terminal tainted-domain handling already reviewed. Mutation/Boolean failure ownership must be audited for this new path too.

### 2. Feed halfspaces through the existing Boolean continuation

Replace the retained subtype refusal in retained_step with a reached source admission using the existing Boolean spine/Steps and recorder. Keep the existing empty-host gate before resolving/lowering second operands. Admit the halfspace only when that original step is reached; retain path-scoped DAG multiplicity and work budgets.

Share raw plane lowering with HalfSpacePlan::lower so BaseSurface, position and AgreementFlag policy stay canonical, while retaining original coefficients/identity rather than only its normalized/sampled result. For polygonal bounds, factor source admission from BoundedPrismPlan and preserve originals; its contour_2d is already sampled and is insufficient as retained source authority. Do not pass a Mesh host into retained evaluation.

Retained numerical outcome must resume the same work::Continuation/Frame::Steps with actual semantic Empty/NonEmpty and the same source/diagnostic recorder. Preserve full-host removal policy explicitly: existing plane work calls guard_against_full_host_removal; inspect its source policy rather than copying a mesh heuristic into the numerical adapter. If a compatibility guard intentionally retains a host, represent that as an authenticated policy outcome with evidence, not a false successful cut. Difference/Intersection mode and AgreementFlag side require independent analytic fixtures. Union with a genuinely unbounded halfspace cannot silently be clipped to a finite host envelope; establish its existing accepted behavior and add an explicit unbounded representation if that case is supported. It remains unresolved rather than receiving a finite wrong answer.

Do not clear any product-level closure requirement merely because one clipping operation succeeds. Subsequent steps, grouped behavior and outer assembly still execute.

### 3. Carry retained host/opening values through the real void controls

Extend existing common outputs/payloads (GeometryOutput, HostPart/Output, opening child completion and context) to carry an ordered retained value family alongside exact mesh family. Use the same VoidControl, OpeningControl and OpeningAdapter state machines. The control can have target/contract-specific data variants; it must not have an independent retained traversal.

A retained opening context contains admitted logical cutters/occurrences plus source/probe decisions and provisional diagnostic effects, not sampled OpeningType meshes. OpeningChild::admit must propagate the parent's selected retained contract into the actual body/item/mapped child. ChildFinished must finish the correct retained output, never call finish()/finish_parts() then relabel it retained. Registry/custom processor dispatch remains reached under the original owner; a mesh-only processor cannot fabricate a retained recipe. An explicit retained custom-processor admission contract is needed for preservation of those extensions, with unsupported cases kept open until implemented.

Preserve existing order:

1. Original relationship/index selection and layer eligibility remain at their current Select/Eligibility transitions.
2. Produce/admit the real host body under the same common child and SourceHygiene.
3. Actual empty host stops before opening-context geometry/late placement/probe work as the existing branch requires. Do not pre-admit every void source while producing the host.
4. One lazily reached opening context admits original related openings through existing policy/source operations, respecting representation choices, placement/RTC decisions, and recorded diagnostics.
5. For each ordered host part, issue cuts against the correct ordered original cutters, feed actual outcomes into the original Ready/accept path, then append the correct part/identity. Repeated mapped occurrence uses are separate logical occurrences even when a definition is shared.

Extend the common opening numerics payload algebra from Mesh to logical host/cutters plus typed Boolean/group receipts. Reuse existing binary Difference and Affine operations where sufficient; grouped numerical operations need original ordered members and a genuine typed group result. Never concatenate mapped cutter parts and claim that is their Boolean union. Overlapping/coaxial grouping needs mathematical equivalence and actual grouped result validation.

Preserve provisional effects: a known eligibility deferral can return to the original ungrouped retained control with the same already-admitted source values; it cannot refund source visits/work or erase reached terminal records. Numerical/transport uncertainty is terminal, not a retry or exact fallback. Route completed-cut records through the existing owned reports/effects acceptance so a later stop preserves earlier completed effects. Validate original request, owner/context, ordered handles/frames and leases before consuming the original reply.

Enable retained VoidedParts/VoidedSubmeshes entry in processing only after the corresponding common control outputs and pending operations exist. Forward the exact immutable void index in OwnedMeshProductionContext. Do not rerun the primary source producer as an untracked second opening pass. Keep legitimate exact-path attempt behavior untouched.

### 4. Restore the layer attempt over the already-voided retained host

Remove the select_retained layer bypass only after LayerControl accepts retained host outputs and drives actual retained plane splits. Preserve LayerProgram admission, single/unshifted-item policy, merge_thin_layers, direction_sense, offset and material IDs. Preserve gateway skip reasons and provisional attempt policy: an ineligible layer attempt may select the original unsliced retained host; a failed required numeric operation cannot be silently marked sliced.

Generalize LayerPlaneRequest/ReadyLayerPlanes to retain an authenticated host value/group instead of Mesh. The empty-host test must use the actual sealed numerical Empty classification. Frame source admission remains **after successful nonempty voided-host acceptance**, preserving callback mutation/lazy diagnostics. Convert the admitted source/world plane into the retained object's actual local metre frame with proper point/covector transform; do not invent a mesh.origin or double-apply unit/RTC/product placement. Existing world-minus-RTC-minus-origin plane code is exact mesh frame policy, not a reusable BRep origin.

Progressively split the same running remainder at each interface, producing ordered band/remainder receipts. Do not intersect independent clones for each material: the existing slice.rs intentionally makes both sides of an interface from the same cut to avoid cracks/T-junctions. Preserve actual semantic empty bands and material/air-gap identity (ids_are_materials, material_id0), without dropping obligations or inventing STEP item identities.

**Critical fidelity gate:** current slice.rs emits uncapped material bands of the host's outer shell. Closed SDK slab Boolean outputs introduce two coincident internal cap sheets and would regress visible/exported shell topology. Store closed analytical region results where needed, but preserve the presentation boundary partition using sealed ancestry that distinguishes original host boundary (including opening reveals) from newly created layer interface faces. Suppress only generated interior interfaces in the established shell presentation contract. Do not guess faces from proximity or triangle normals. This needs a qualified face-copy/intersection provenance mechanism and remains a required implementation, not optional polish.

Layer result metadata must carry ordered logical bands, material binding, their source/output ancestry and shared interfaces. Extend final assembly to consume those partitions once. Preserve existing too-few-layers, no-plane, unsupported placement and degenerate interface behavior through the same LayerSkip/control decisions; a deliberate unsliced result needs an authenticated explicit no-split decision, not clearing MaterialLayers globally.

### 5. Close obligations per actual product and integrate both targets

Replace blanket remaining-requirement initialization/removal with owned per-product completion facts discharged only by the original controls: no-related-openings eligibility, or all required cuts accepted; no-required-layer eligibility, or all layer split/presentation obligations accepted. Include each occurrence, type-map branch and external host opening. Keep IfcAppearance and PersistentFaces separate; neither a clipping receipt nor a valid logical layer collection satisfies them automatically.

Use the shared processing P3 pending/accept/ledger engine for native/browser Clip/Split/group receipts. Extend actual runtime lineage with named derived halfspace/split operations and source/interface provenance. Native per-object managed leases and browser object tokens remain actual authority; capture all inputs through the last real use. Final manifest must bind every logical operation output and partition to one live actual sealed output or authenticated semantic Empty. No source-only display, partial boolean result or unresolved requirement may publish as final net geometry.

## Required execution evidence by cut

Every new route requires actual native SDK and actual module Worker tests; protocol fixtures alone cannot qualify it. Keep current tests/oracles intact, and pin exact source/artifact identity. Required SDK/Rust tests must demonstrably execute with actual fixtures rather than skip silently.

- **Finite plane/halfspace:** box/cylinder/rational source cut by oblique planes, both AgreementFlag values and Difference/Intersection; disjoint/full-removal/tangent/coincident plane; deeply translated survey/mm/RTC local frames; negative/nonuniform maps; tiny/large finite extents; conservative domain excludes display bounds. Polygonal bounded case with tilted Position.Z, independent plane normal, near-parallel source, concave boundary and repeated/trimmed edges. Test original immutable source, derived certificate identity, volume/sections, watertightness/caps/orientation, actual Empty and release survival. Refusing an uncertified case is an honest failing preservation gate, not passing coverage.
- **Openings:** actual common product host with two overlapping openings, nested/reused mapped cutters, a redundant void on an already-holed profile, diagonal/nonrectangular and skewed extrusion, multiple host parts and style IDs. Real-source anchors already present: tests/fixtures/issue_2019_wall_two_overlapping_openings.ifc, issue_3641_voiding_trap.ifc; inspect and reuse processing tests issue_2019_void_order_invariance, issue_3641_voiding_trap, issue_5410_redundant_opening_on_voided_profile, issue_5739_local_frame_voided_wall, issue_5409_opening_display_colour, opening_filter_ignore_opaque and common_opening_program. Add actual retained witnesses through the same consumer; existing exact passes are not retained qualification.
- **Layers:** real multi-material wall with overlapping openings, thin/air-gap layers, rotated/sloped local frame, direction_sense +/- and offset, empty voided host, skipped/degenerate layers, source mutation observable only at late-frame gate. Independent volume partition plus outer-shell/interface topology, material IDs and 2D section closure. Verify no doubled internal sheet, cracks, T-junctions or missing opening reveal faces; closed analytical volumes alone cannot pass.
- **Order/transactions:** foreign/swapped/stale receipts, input frame changes, repeated acceptance, source/context invalidation, actual lease release before accept, last-Drop and slot reuse, real dispatched Worker drop/timeout/restart, native Child reap. Stop after a completed cut but before later source/SDK step and verify original diagnostic/first-fault order. Group deferral preserves source work and only rewinds authorized provisional numerical effects. Verify empty-host laziness with malformed never-reached opening/layer source, and actual custom-processor policy/reentrancy.
- **Whole consumers:** final retained native/browser products must match agreed real-model shape/material/occurrence/face evidence and required existing export/viewer contracts. Run canonical WASM/build/types/root Turbo checks, workspace tests/Clippy, default exact determinism/reference gates, installed assets and end-to-end worker-pool A/B perf/memory after integration. Preserve all old exact-side tests. No tolerance widening or baseline repin merely to hide a semantic loss.

## Ownership boundaries and unresolved engineering decisions

Geometry owns raw source admissions, logical operation/output identities and the existing control/continuations/effects. Processing owns original transactions, ordered actual receipts, source/context/lifecycle checks and final coverage. Runtime/native adapter owns finite-domain certification, checked SDK copy/cut/split ownership, actual object leases and generated-boundary provenance. P3 owns one cross-target execution/acceptance engine; add operation adapters there rather than another browser walker.

Before broad implementation, settle and execute the actual SDK clipping/split/boundary provenance contract: inspected headers do not establish a robust paired plane split or exact source-face ancestry. Source supports currently refused by affine/rational admission remain explicit preservation work too. Halfspace union/unbounded outputs and existing full-removal compatibility policies need separate source-backed semantics; do not label finite-domain clipping a solution for them. These uncertainties affect implementation choice, not authorization or scope.

## Exact inspected Git blob hashes

| Path | SHA256 |
|---|---|
| `docs/architecture/geometry-platform-production-plan.md` | `508ac90b22f44fb66acc94e4ba70f4650c61874ed297f65f37df75cd8267696b` |
| `rust/geometry/src/program/retained.rs` | `30a3da2a0875e01a3033614574822646d524511b8c81507cd055c9818d4319fe` |
| `rust/geometry/src/program/boolean/retained.rs` | `dab1ea81e548379a5fe3dba2dd3f999f4ce2a4cfe80f591e14146598b27592e4` |
| `rust/geometry/src/program/boolean/work.rs` | `89ce258a0668683609de3824338de12327339f4d91fa4c9314c1ae45b1cc9a2e` |
| `rust/geometry/src/program/inner_ready.rs` | `17d326d778f75143cbf1ad49b913f7184ba21ec01f3e54bc0df6cfde4c2093f6` |
| `rust/geometry/src/program/inner_opening.rs` | `9c0e9981bea963d8cb08efb3c64b37fec6d2cec98f9e76a5fcade28fa3ec9020` |
| `rust/geometry/src/program/inner_voids.rs` | `88e787d7e3661b4387a87f13e92b725c986b1194bd38111d818a7b831ee43d4d` |
| `rust/geometry/src/program/inner_layers.rs` | `1e9ee4e767cbbc25f0bcdf8c53f44077fedc8bc7d4ffa0d515c6f816534273c0` |
| `rust/geometry/src/program/inner_product_adapter.rs` | `910365c8c2cf62ad18675216cae52cd85c05cf4f05412c3ed1e0113316bffa83` |
| `rust/geometry/src/program/openings/mod.rs` | `bc15fad3da622447fd87076fe59dfcd037f70dfcf52b4835828214adb758dee0` |
| `rust/geometry/src/program/openings/control.rs` | `c659e97f44f7b919fc7d3cf92e83f5ff16e198a721cb6b79d9153240d394ada2` |
| `rust/geometry/src/program/openings/requests.rs` | `2554dcec5b6da6cf243412ec5c36bc5f2fad352bdbc77e4f897fbd51caa4ad9b` |
| `rust/geometry/src/program/openings/decision.rs` | `de1b222304f8bfa80b2acc85056ca3935cb9d59121488bd7e9d50b9c91c971bd` |
| `rust/geometry/src/program/openings/execute.rs` | `589664a1d1168d30dbd8010609356eb7d7c52eff28440d5331e9768846e7ec6b` |
| `rust/geometry/src/program/layers/mod.rs` | `680e647b54e06eaf092e079c66f35ccb7fafffef581958663af59f459a62066a` |
| `rust/geometry/src/program/layers/planes.rs` | `8e6fd9faf00f0a14baba69ce6b8bf9907850a3305c0c5e71d4b06ac341017952` |
| `rust/geometry/src/program/layers/slice.rs` | `961dedcb694c48e97abee534fe9443501804e58e15c6256dddcf8e8e2b689d41` |
| `rust/geometry/src/processors/boolean/half_space_plan.rs` | `c450033083987ddc41bee9988b011925e7463594087b26b4a81b56f7d6cfc137` |
| `rust/geometry/src/processors/boolean/bounded_prism_plan.rs` | `935ff0c56a7ea838a47d1fb0acc0e1f47fc38cdc3fe7a57e1df017433173ef51` |
| `rust/processing/src/element/session_inner.rs` | `c55dc9550794d9e7e8e62d2cbb4b52f5397f453c12279dc779e1be715f75f025` |
| `rust/processing/src/element/session_protocol.rs` | `0e09c06add8d0f60e2c922560ed2353be7dfa09a8149b533cf2000a2271f0418` |
| `rust/processing/src/element/session_retained.rs` | `8f1edce636f1c27a08c8b7de6fdc06b9f97c947bfb8f60a9758e095bc8b72241` |
| `rust/processing/src/element/session_retained/issuance.rs` | `59b36fc155b1a09d3ad3da815ce694f851f296f9229121e5249cd3e9c692db27` |
| `rust/processing/src/element/session_retained/acceptance.rs` | `586086c77d6620f63fd593dfa004c00b7deeef56e17f4c4fa5dbec3c473cbf27` |
| `rust/processing/src/element/session_retained/value.rs` | `6af94219bfdf051f3b739e37c706fb11c041005f74338bbcee7a7f238d0199aa` |

## Additional preservation prerequisite: shared graph stack safety

Frozen program/retained_walk.rs::RetainedWalk::child bounds the entire mixed ancestry by MAX_MAPPED_ITEM_DEPTH32. Existing mapping32 and Boolean-depth/iterative-spine policies are separate domains. The new shared cap is a deliberate safety measure, but valid mixed product/mapping/Boolean/opening/layer ancestry may consume it earlier. Neither a passing shallow corpus nor an explicit refusal alone establishes full no-loss preservation; do not raise an arbitrary cap and call the problem solved. Root shared work limits also need accepted-domain compatibility evidence, not only termination tests.

Before expanding retained opening/layer nesting, make common child dispatch iterative across controllers. The current GeometryProgram::request delegates into child.program.request; inner_boolean::poll_boolean and other adapters recursively forward nested child polling/ready/replies. Boxing controllers reduces inline frame size but does not remove this call stack. Use an explicit owned driver frame/arena or a heap continuation stack with EnterChild, AwaitOperation and ResumeParent events. The parent frame stores the original typed continuation/request identity and provisional effects; the active leaf alone performs source/numerical work. Unwind completion/validation/cancellation and subtree destruction iteratively as well, so a valid deep chain cannot recurse through Drop or cancel_with_reports. Keep one existing controller algorithm, replacing call-stack plumbing rather than adding a retained walker.

Retain path-scoped cycle membership over actual source occurrences (remove on exit; shared siblings remain distinct), existing per-domain mapping depth and Boolean operand/visit rules, and a monotonic work budget for broad DAG fan-out. Charge/reserve heap frame/path backing before growth under the captured resource context. Controller transitions themselves must debit work so source-free cycles cannot escape. Keep typed reporting of the exact domain/budget refusal and first fault; no budget refund on suspended child acceptance. Validate original source epochs/leases when returning from a child, preserving original diagnostic and callback order.

Evidence must include previously accepted mixed chains crossing the32 combined-frame boundary while each original domain remains legal, deeply valid acyclic chains, repeated sibling DAG occurrences, true cross-domain cycles, broad DAG budget exhaustion and cancellation/deallocation under normal native/WASM stack sizes. Preserve current exact outputs on real corpus and demonstrate old per-domain admission boundaries. Pending iterative conversion remains a preservation hold; it must not be hidden by the new shared cap or by increasing stack settings.

Additional immutable blobs used for this prerequisite:

| Path | SHA256 |
|---|---|
| `rust/geometry/src/program/retained_walk.rs` | `24ed2f76b1c381d68d751302b12011740ff482f630d0c7adb501a4ee8c73b91b` |
| `rust/geometry/src/program/inner.rs` | `a8472ee0b11966ccf9eb21e7f88868763229c71ce99e832d08b93ebc32a6c000` |
| `rust/geometry/src/program/inner_boolean.rs` | `d32348c037516ac9731714395bd17227b9097ebff42cd8bdad85844348d0c8b5` |
| `rust/core/src/limits.rs` | `087201d6558a9600204fec9b18bfcc8b117dade374870f9f6d81f5d374eb0acb` |
