<!-- SPDX-License-Identifier: MPL-2.0 -->
# Planned common ProductProgram

This is a planned extension of the [owned source/execution
design](geometry-platform-source-execution.md),
[canonical product session](geometry-platform-product-session.md), and
[synchronous work boundary](geometry-platform-work-boundary.md). The current
[capability inventory](geometry-platform-capabilities.md) describes implemented
coverage. The types below describe the target architecture. The
[representation and constructor phase](geometry-platform-product-program-phase-one.md)
is now integrated, including owned mapping control and opening-item probe policies.
Its [delivery and integration evidence](evidence/geometry-platform-program/) keeps
child qualification separate from current assembled-source checks. Complete
source-independent execution remains unqualified; boolean, opening classification,
layer and late presentation control still require migration.

Implementation proceeds in reviewable phases. Whole-platform completion requires
the complete source, control, consumer and fidelity gates below. Historical
qualification receipts describe their recorded source and remain unchanged.

## Existing state to retain

* [`session.rs::ProductState`](../../rust/processing/src/element/session.rs) owns job, attempt
  Stage, color, keep_order, Scopes, hasher, meshes, occurrences, protocol, owner and pending-mapped
  adoption. `session_accept.rs` performs once-only assembly and the original retry drain. Keep this
  presentation/attempt authority; do not duplicate it in geometry.
* [`OwnedProductExecution`](../../rust/processing/src/element/owned_session.rs) owns one
  `Arc<OwnedMeshProductionContext>` and wraps the same ProductState transitions. It validates source
  lifecycle before work/accept/publication and after final diagnostic callbacks. The snapshot is
  already implemented, not a proposed new wrapper.
* [`element/model_context.rs`](../../rust/processing/src/element/model_context.rs) owns map
  components in `OwnedMeshProductionData` Arcs, with `ProductionContextId { load, source_epoch,
  revision }`. New same-source snapshots preserve prior snapshots; explicit invalidation expires the
  prior source epoch. The identity is process-local authority, not a content hash or transport/load
  protocol. `appearance/owned_context.rs` also consumes snapshots. Keep these actual consumers.
* [`session_work.rs`](../../rust/processing/src/element/session_work.rs) still calls whole router
  functions for primary submeshes, type maps and fallback parts. That is the remaining coarse
  boundary to replace. Calling those same functions behind a newly named generic command is not an
  implementation of this design.
* [`router/mapped_item.rs`](../../rust/geometry/src/router/mapped_item.rs) now drives owned
  `mapping/{merged,submeshes,occurrence}.rs` frames under one architecture, with distinct consumer
  policies. No decoder/router guard is stored. These already implement real mapping control, but
  their `advance` methods still both admit source and execute numerics in the same synchronous step.
* [boolean/CSG continuations](../../rust/geometry/src/processors/boolean/continuation.rs) own
  boolean/CSG control frames, path membership, visit counts, host meshes, empty flags, recovery and
  diagnostic marks. Driver currently borrows decoder/recorder for the run. Convert this into an
  owned child program plus a short-lived adapter; do not replace it with the eager ConstructionBatch
  graph.
* Production constructors already use owned lower/evaluate payloads across the admitted families.
  Lowering sometimes samples curves/profiles or emits source diagnostics. A source admission is
  therefore not promised to be zero-cost or purely symbolic. Evaluation must retain the exact
  current raw-file-unit/RTC/quality arithmetic contracts.

## Placement and crate boundary

Put `ProductProgram` in a new `rust/geometry/src/program/` module. It owns geometry-source control
for one requested product attempt or type-map request. Processing owns presentation, attempt retry,
model snapshot and outer request acceptance; geometry must not import processing's style/context
types.

`ProductState` gets `program: Option<ProductProgram>` plus the currently reached inner request.
`OwnedProductExecution` continues to hold the one snapshot Arc. An ephemeral `ProgramInputs<'_>`
borrows the actual selected void/texture data and geometry policy from that snapshot/router only
during a step. It is never stored in ProductProgram or its frames. Material-layer lookup currently
belongs to the router, not OwnedMeshProductionData; retain that owner binding until an explicit
immutable geometry-configuration snapshot includes it.

Expose only the small cross-crate integration API actually used by processing. Keep source adapters,
mapping state and numerical plan details internal to geometry. The current public router entry
points should become synchronous drivers of this same program when migrated; direct consumers must
not keep a separate old walk.

## Concrete types and control contract

Conceptual Rust types (names can follow local conventions):

```text
ProgramEntry = Product {
    element: DecodedEntity,
    consumer: Styled { allow_instancing, texture_policy } | MergedParts,
    hygiene: SourceHygiene,
    opening_mode: NoOpenings | StyledHost | MergedHost,
} | TypeMap { representation_map: DecodedEntity, texture_policy }

ProductProgram {
    id, next_sequence,
    frames: Vec<Frame>,
    resources: ResourceSlots,
    mapping_path: MappingPath,
    boolean_contexts: BooleanContexts,
    pending_request: Option<RequestIdentity>,
    terminal: Option<ProgramOutcome>,
}
ProgramRequest = Admit(SourceAdmission) | Execute(ReadyOperation) |
                 LeasedExtension(ExtensionCall)
ProgramResponse = Admitted(AdmissionValue) | Evaluated(OperationValue) |
                  ExtensionReturned(OperationValue)
ProgramOutcome = Complete(GeometryProductValue) | SourceFailed(SourceFault) |
                 Stopped(ProgramStop)
ProgramStop = ResourceRefused(ResourceReport) | Cancelled(CancellationReport)
```

Each inner request has program identity, sequence, typed operation kind, occurrence role and
resource-slot generation. Outer WorkRequest still carries actual ProductionContextId and
session/owner identity. Its executor records expected inner identity; reply data cannot choose
another command, stale slot, context or registered emitter. Rejected packets remain owned and
unconsumed. No reply-driven generation rebase.

Typed values must distinguish an ordinary item mesh, an operand `(Mesh, empty_recorded)`, ordered
frame parts, styled collection, optional texture result and optional layer candidate. Do not
collapse valid-empty subtraction, unsupported-empty operand, missing geometry and an instance-only
placeholder into one `None`/empty Mesh. Ordinary SourceFault preserves typed original errors and
scoped reports; the enclosing consumer decides skip, propagate, annotation-terminal or attempt retry
according to its existing policy. A ProgramStop bypasses those recoveries.

Resource slots hold actual intermediate meshes, parts, SubMeshCollection, f64 transforms, classified
opening data and operation outputs. Meshes in these slots are numerical results/inputs, not source
recipes. Commands can move resource handles rather than deep-clone a host for every message. Slot
lifetime is explicit; free only after the final consumer/rollback boundary. A typed handle includes
slot generation so reuse cannot alias a late reply.

The program's `request()` advances owned control only until the next required source read, numeric
operation, extension callback or final result. `resume(response)` changes the matching frame exactly
once. No eager source prewalk, no copied IFC bytes, no decode closure, no stored source/entity
references, no RefCell borrows and no installed budget, unsupported-counting or triangle-order scope guard across calls.

Suggested frame groups:

* `Entry`, `AfterLayerProbe`, `AfterLayerBase`, `AfterLayerPlanes`, `AfterLayerSlice`.
* `AfterProductShape`, `NextRepresentation`, `AfterRepresentationItems`, `NextItem`,
  `AfterTextureAttempt`, `AfterRawItem`, `AfterItemGeometry`.
* `Mapping(MergedWalk | SubmeshWalk)` with their current distinct frame states and source/occurrence
  metadata; `AfterMappedResult` joins the original output range.
* `Boolean(BooleanProgram)` containing the current Walk/Steps/AfterBase/AfterBatch/AfterStep frames
  and path context. CSG wrapper entry stays explicit and shares the active recorder/path as today.
* `TypeMapItems`, `AfterTypeMapItem`, `AfterTypeMapOrigin`, `FinishTypeMap`.
* `AfterHostParts`, `NextOpening`, `AfterOpeningParts`, `AfterOpeningItemProbe`,
  `AfterOpeningClassification`, `AfterOpeningMerge`, `AfterRectCapture`, `AfterBool2dCapture`,
  `AfterOpeningApply`.
* `AfterSourceHygiene`, `AfterWeld`, `AfterPlacement`, `FinishConsumer`.

## Source admissions: what they own and when they happen

`SourceAdmission` is a closed operation tag plus owned decoded source/context handles. Execution
borrows the live authenticated decoder. Return owned payloads or the actual typed source fault;
capture direct refusal evidence at this point. Dormant and skipped admissions emit nothing.

Required admissions include:

1. `ProductShape`: existing `representation::product_shape` resolves the whole representation list
   before selection or any item work. Preserve exact errors/leniency and source read order.
   Selection uses the canonical Select predicate and direct-versus-mapped exclusion.
2. `RepresentationItems`: existing `rep_items` resolves a whole selected representation's item list
   before its first item. A bad later ref in that list still fails before earlier items execute. Do
   not decode descendants of an unselected representation.
3. `MappedSource/Transform/Representation/Items`: split current mapping `enter` methods into reached
   admissions, preserving the DIFFERENT order tables below. No claim or lookup may move ahead of its
   old point.
4. `BuiltinLower`: the actual selected built-in owned payload, with explicit raw/RTC domain and
   quality. Profiles/control points may be sampled here. Reuse existing lower functions; no parallel
   IFC decoder.
5. `TextureLower`: real texture-index selection plus owned geometry/UV constructor payload. Existing
   failed textured build must resume the plain branch; it is not a terminal unsupported-family
   verdict.
6. `Placement/MappingOrigin`: own admitted f64 transforms at the old reached point, not once eagerly
   for the entire model/product. Repeated placement reads currently use worker memoization; do not
   change a malformed/future callback read's precedence by hoisting it.
7. `LayerEligibility`, `LayerPlanes`, `OpeningEntity`, opening geometry/probes, rectangle and bool2d
   capture: each is a reached phase below, not one opaque router traversal.
8. Boolean/CSG source steps reuse their present spine, delayed operator/SecondOperand admission,
   PBHS candidate read order, role-specific WithVoids source contracts and lazy unit discovery.
   Empty host gates and deferred batch failures decide whether a later admission happens at all.

Current mapping order that remains mandatory:

| Consumer | Reached order |
| --- | --- |
| Merged source | path/depth -> MappingSource -> transform -> shared/local cache lookup -> representation on miss -> required whole Items -> source-loss claim -> ordered children -> cache publication -> mapping bake |
| Styled occurrence | depth and mapped path -> MappingSource -> representation -> transform -> single-solid eligibility/template decision -> optional ensure-shared/placeholder -> source-loss claim -> optional whole Items -> ordered children -> successful-child appended-range transforms -> template retag |

Merged errors remove path IDs; styled mapped source failures intentionally leave admitted IDs sticky
for later siblings. Preserve these currently different compatibility policies. Inner source counting
overrides outer non-Body suppression. An owned bool policy is installed only during reached work and
restored on normal return/error/panic. Claim once when reached, never again when resuming a frame.

TypeMap is its own entry mode, not fake occurrence meshing: it admits map representation/items in
its existing order, keeps each textured item separate, merges untextured parts by frame and applies
MappingOrigin after item processing. Non-Body type maps still walk; only source-loss counting is
gated. Nested maps in this existing type path currently use the merged consumer and therefore do not
magically gain a UV channel. Do not silently change that historical behavior while qualifying
control ownership; record the coverage limitation separately. `plan_type_geometry` remains the sole
SuppressInstanced/EmitTagged decision and preserves ordered map/class pairs.

## Source-free numerical operations

`ReadyOperation` contains only owned admitted parameters and typed intermediate-resource handles.
Its evaluator needs numerical execution services/effect sinks, never a decoder. Proposed variants:

* `Construct(OwnedConstructor, ConstructionFrameContract)`: factor the current constructor enum into
  a common internal payload reused by canonical entry, source-free evaluate and optional graph. Keep
  built-in dispatch admission separate from family labels.
* `SolidBoolean(SolidBooleanPlan, host, cutter)`, owned plane/prism/group cutters, void-shell
  numeric recipes and explicitly prepared boolean batch operations. The exact kernel remains
  permanent. Existing budget charges and numerical order stay at their original execution sites.
* `TextureConstruct(TextureGeometryPlan, admitted texture/UV data)`; no image re-resolution per
  occurrence.
* `MergeSourcePart`, `MergeFramePart`, `TransformMappedRange`, `RetagTemplate`, `SourceHygiene`,
  `Weld`, `ApplyPlacement`. Retain existing helper arithmetic and ordered merges. A texture-bearing
  weld carries UV remapping; original versus mapped arrays cannot be compared without accounting for
  that remap.
* `MergeOpeningClassifications`, `LayerSlice(owned planes/visual layers, host)`,
  `ApplyOpeningContext(OwnedVoidContext, host, host role)`.

Prepared opening context may contain evaluated cutter meshes as numerical resources plus admitted
profile/plane data. It is not advertised as authored source. `apply_void_context` already has no
decoder: exposing its admitted numeric payload is a genuine seam, unlike wrapping
`build_void_context` as an opaque Execute command.

Existing `try_staged_bool2d` holds HostAttempt and telemetry transactions only inside one
synchronous numeric evaluation. Preserve this atomic numeric scope initially. If later splitting its
residual/correction steps, replace those guards with owned checkpoints and explicit commit/reject
frames that restore only the affected host and counters. Never store the current borrowed
HostAttempt/Transaction guard across polls.

## Actual registry dispatch and custom commands

A custom/configured processor that requires mutable decoder access is `LeasedExtension`, never a
source-free ReadyOperation. Its payload owns decoded item, selected registration token and reached
invocation policy; execution invokes the actual selected instance under ProductOwner.work. It can
mutate caches/units, create lexical canonical children, use independent owner halves, or lend the
actual decoder to a joined scoped worker with a fresh router. Waiting replies cannot inherit that
authority. Final take_bool_failures callbacks remain read_work in restored caller triangle order;
retry drains remain in product mode.

Do not infer execution from `ConstructionFamily`: actual registry dispatch role/origin must admit a
typed built-in lower entry. One concrete seam is a default-None `GeometryProcessor::lower_owned(...)
-> Option<Result<OwnedConstructor>>` entry, overridden by the actual built-in processor instances
and delegating their existing lower methods; selected configured/custom instances keep their
original RTC/process callback unless they explicitly opt into that typed contract. An alternative
registry-owned lower entry must remain bound to the actual selected instance/configuration, not
recreate a processor from its advertised family. The trait/API change needs a real canonical
consumer and all consumer builds; it is not permission for unused public exports. Built-in operand
factories also retain their present contextual dispatch policy rather than automatically honoring a
new product override. Record real entry when the lower/evaluate adapter is entered, not on
metadata-only lookup. The sparse entry trace is still not complete provenance.

Router/decoder generations may change inside trusted synchronous callbacks. Subsequent source steps
must observe the same current service state the old single synchronous call would observe. Do not
freeze mutable decoder units, caches or dynamically reached configuration reads at program
construction merely because the model snapshot is immutable. Preserve fixed root-call arguments such
as boolean quality where the old call already captured them. External changes while a reply waits
still fail acceptance. Model source invalidation rejects publication regardless of successful owner
commit.

## Layer/opening state machines and their distinct empty contracts

`try_layered_sub_meshes` is first in both styled entry modes. Preserve its ordered checks: attached
buildup/sliceable -> fewer than two layers -> single-unshifted representation probe -> merge thin
visual layers -> fewer than two visual layers -> merged base product with voids -> empty base ->
placement-based planes -> numeric slice -> fewer than two resulting submeshes -> original
warning/fallthrough. Successful layer output performs its own hygiene, marks material-ID domain and
returns early; it must not pass through an extra generic cleanup/placement path.

Styled void entry with no opening IDs returns empty primary output. Otherwise materialize
untextured, non-instanced IndexOnly host submeshes. If empty, return BEFORE opening context reads.
Merged void entry with no openings delegates ordinary merged parts; WITH openings it builds context
after host parts even when those parts are empty. Preserve separate frames for those paths. A
consumed host is valid empty geometry and must not trigger plain fallback.

Opening context order is classification -> merge rectangular opening data -> conditional rectangle
source capture -> conditional bool2d capture. Classification itself is a child program, not a single
eager decode-all request: for each opening, decode entity, build nonempty frame parts using the
ordinary merged consumer, then reach per-item probes/classification in the current order;
errors/empty results skip the same opening without reading later phases. Preserve regular versus
quiet classification, world-frame grouping, diagnostic pushes and exact branch precedence in
`voids/synthesis.rs` and `probe.rs`. In particular, the classifier accumulates its per-host
diagnostic vector locally while per-opening counters can change, and publishes that vector at its
current finish point; an owned frame should retain the vector rather than publish each line early
where a reentrant callback could observe it.

Numeric application retains rectangle -> staged bool2d -> prism -> residual/exact/fallback/repair
order, host-local relativization and f64 restoration. Keep UV dropping on cut meshes, post-cut
sliver hygiene, instancing invalidation and host-consumed effects. One prepared context is reused
over ordered host submeshes; no per-submesh re-decoding of openings. Runtime flag reads stay at
reached points in the synchronous driver; future scheduling requires explicit authority for
ambient/global policy switches not currently covered by a context version.

## Resources, effects, reports and assembly

The [planned resource-admission contract](geometry-platform-resource-admission.md)
specifies reservation ownership, work and memory accounting, terminal refusal,
and cache publication constraints for this execution store.

Immutable model snapshot stays once per effective model/batch, including current browser override
revisions. ProductProgram does not clone those maps. `ProgramInputs` selects current snapshot
components and router layer/configuration services. Own source and representation identity is
model/source-epoch scoped, not bare express ID across loads.

Mutable `ModelExecutionStore` remains leased separately: point/entity/placement memoization,
mapped/content meshes, source-loss claims, diagnostic claims, templates/materialization flags,
host-consumed flags and grouped diagnostics. Locks cover brief lookup/claim/publication only; no
lock spans meshing, callbacks, rayon or scoped joins. First extract typed methods over the current
stores rather than create an independently authoritative second cache. Preserve each claim's CURRENT
domain: mapped unsupported-source claims are per router (native per-element, browser per-batch),
while structural diagnostic-claimed state can be model-pass shared. Hoisting every set into one
model-global namespace would change counts. Carry the execution-owner/pass claim scope explicitly
even if the backing store is model-owned.

Effects have three distinct categories:

* Reached execution effects (claims/cache lookup and conditional publication): apply at the original
  authenticated point, once. Return a receipt containing command/effect identity; accepting a reply
  cannot replay or retroactively reorder it. In particular, delaying competing first-claim effects
  to assembly changes winners and diagnostics. Independently completed valid source entries retain
  their original publication point even if a later branch stops. Only incomplete/dependent partial
  cache or template-marker state rolls back; whole-product atomic cache visibility would be a
  separate policy change.
* Owned numerical/source reports: accompany the operation with exact ordering and refusal evidence.
  Initial adapter can preserve established grouped router/TLS logs under the lease; that does not
  claim fully owned transport effects. Move them only with equivalent emitter-specific grouping and
  final-drain qualification.
* Canonical presentation: stays exactly once in ProductState after all reply/context/owner checks.
  Preserve fixed colors, type-color correction, palette splitting, UV/texture, material-versus-item
  IDs, properties, site-local rotation, hash/closure/volume order and degenerate retraction. A valid
  occurrence-only primary is success.

All mesh slots retain full Mesh data: positions/normals/indices, origin, bounds, RTC flag,
local_to_world and instance metadata. Styled slots retain geometry ID/domain, UVs and attachment.
Type results retain ordered parts and class. Mapping identity/local/canonical/world matrices stay
separate. Do not reconstruct omitted metadata from final vertices.

`ProgramStop` is terminal and distinct from recoverable SourceFault/empty/unsupported results. It
may not be swallowed by a mapped child catch, opening skip or product retry. Reservations must
account for accumulating work AND materialized buffers/parts before clone/merge/reserve; depth/path
and cache hits do not bound exponential DAG output. The resource-admission contract must be
specified and qualified with the common execution store. No arbitrary small default cap or global
memoization of accumulated occurrences qualifies as a no-loss migration.

## Implementation sequence and deletion criteria

1. Add `geometry/program/{mod,request,state,source,execute,resources}.rs` with typed entry/values.
   Factor shared OwnedConstructor payload out of construction's private enum and attach actual
   selected built-in lowering entry. Keep current lower/evaluate process wrappers using those same
   implementations. Add a driver whose ONLY numerical calls are ReadyOperation evaluation or
   explicit LeasedExtension, and whose source calls are enumerated admissions.
2. Move ordinary merged/styled product loops from `router/processing.rs` into ProductProgram frames,
   preserving alignment-first and layer-first routing and whole-list admission. Existing direct
   router functions immediately drive this program. Source-free frame/merge/transform/hygiene/weld
   helpers move rather than duplicate. Do not mark this complete while a nested mapping request is
   an opaque call to the old run method.
3. Refactor both current mapping advance methods to yield typed source/cache/control/numeric
   requests; move their owned frames into ProductProgram child state. Preserve distinct order,
   sticky-path policy, errors/truncation, cache publication and UV/placeholder/template rules.
   Remove their old combined admit-and-execute step loops when the common driver becomes their
   consumer. Cache service effects remain at exactly the same reached point.
4. Refactor boolean Driver into owned BooleanProgram plus ephemeral source/numeric/recorder adapter.
   Retain exact FirstOperand walk, operator/second faults, batch candidate snapshots, empty flags,
   role-specific void shells and mark-relative failure order. Use the existing family payloads and
   SolidBooleanPlan; delete any superseded decoder-bound run path rather than keeping a second
   engine.
5. Move TypeMap item/origin/finish control from textured.rs into the same program, retaining its
   distinct type semantics and unsupported counting. Complete texture lower/evaluate ownership and
   stable indexed UV behavior. No UV fidelity claim can come from a binary decoder-only test.
6. Extract prepared numeric LayerSlice/OwnedVoidContext evaluation; replace layer/base/opening
   classification/probe/capture traversal with the explicit child frames above. Ordinary opening
   source geometry uses the same product consumer, not a new source walk. Preserve quiet residual
   classification and atomic numeric rollback. Remove superseded whole-source layer/opening builders
   after all callers drive these frames.
7. Change `session_work.rs` from whole router calls to the common program driver. Retain existing
   outer WorkKind results initially so assembly, retry drains and native/browser/appearance
   consumers stay singular. Then expose finer internal tickets by the same request protocol;
   geometry operations do not each assemble a product. Public direct router APIs and canonical
   producer now consume the same complete control layer.

Steps are reviewable implementation phases, not independent family activation. Source/executor
split, all mapped/type/layer/opening paths, custom callbacks and all actual consumers are the
completion unit. An opaque call to an old source walker is an explicit remaining requirement, never
a completed ReadyOperation.

## Completion gates

* Exact reached read/error and bulk-list timing, source claim/cache hit/publication effects,
  budget/quiet/transaction rollback, grouped retry/final drains and terminal-stop behavior.
* Entire constructor dispatch registry and custom registrations; nested same/mixed/ancestor owner
  callbacks and scoped-thread decoder borrowing; callback source/configuration invalidation and
  final diagnostic callbacks.
* All Mesh/frame/UV/material/palette/property/type/occurrence/hash/closure channels, including real
  authoring fixtures, derived nonidentity nested texture invariants, multi-frame openings and
  consumed/instance-only outcomes.
* All native/browser/appearance/export/runtime consumers, immutable source manifests/complete-scene
  comparisons, repeat-baseline stability, full workspace/Clippy/WASM/Python/type/build gates and
  platform determinism where applicable.
* Explicit fanout work/output resource policy with terminal reports; stale replies and unsupported
  ordinary source faults cannot conflate with resource refusal. No async/remote/cancel readiness
  claim until complete effects/lifecycle contracts exist.
* End-to-end worker-pool timing, peak/retained memory and byte/scene identity on base versus branch.
  Owned control is a maintainability result; performance improvement requires measurement.
