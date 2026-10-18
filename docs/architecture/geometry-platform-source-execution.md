<!-- SPDX-License-Identifier: MPL-2.0 -->
# Owned representation source and execution plan

This design extends the [canonical product session](geometry-platform-product-session.md)
and [synchronous work boundary](geometry-platform-work-boundary.md) to own the
remaining representation, mapping and opening control flow. It specifies the full remaining contract; implementation milestones below do not
establish qualified whole-platform coverage. See the
[capability inventory](geometry-platform-capabilities.md) for implemented scope.

Implementation proceeds in reviewable phases. Whole-platform cutover requires all
existing consumers, source families and conditional paths to satisfy the common
contract. An internal phase does not authorize activation for only easy families
or a claim that unrelated old traversals have been replaced.

## Current useful foundations and their limits

* `rust/processing/src/element/session{,_work,_accept,_owner,_protocol,_state}.rs` owns product
  attempts, ordered type maps, work/reply identity, assembly and retry boundaries.
  `session_work.rs::primary`, `voided_parts`, and `type_map` still delegate entire source walks to a
  live router/decoder. Its borrowed `MeshProductionContext` is not a transported context snapshot.
* `rust/geometry/src/program/boolean/{mod,state,batch}.rs` is the model for
  demand-driven execution: owned frames, one returned value slot, path-local admission, monotonic
  visit charges, delayed second operands, exact batch failure marks and cleanup. It still reads
  source at reached frames. Preserve that distinction: an owned continuation is not yet a
  decoder-independent complete source program.
* `rust/geometry/src/construction/mod.rs` owns sampled/raw constructor variants and typed
  lower/evaluate seams used by production. Its separate eager `ConstructionBatch` compiles raw
  file-unit roots under independent admission bounds; it excludes placement/RTC/appearance/openings
  and cannot replace this layer. Reuse its family payloads and the production lower functions, not
  its eager graph compiler or memoized boolean execution.
* `rust/processing/src/authored_geometry/{mod,planning,inventory}.rs` is a source inventory and
  explicit authored analytic contract, not full canonical representation coverage. Preserve source
  keys, raw units and complete-source versus unresolved-evaluation status. Do not reinterpret a
  boolean operand's analytic source as the final product. The next continuation can eventually
  populate that inventory from canonical admissions; it must not run a second eager source walk to
  manufacture command coverage.
* `rust/geometry/src/document/{mod,types,validation}.rs` owns mesh definitions and occurrences with
  document/revision/generation handles. It is an optional retained discrete document; it does not
  own the canonical product traversal, source errors, material semantics, or caches. Its validity
  checks are useful for accepted retained publication, but no definition should be admitted merely
  because an intermediate mesh exists.

## The actual control and data boundaries

1. `router/processing.rs::process_element_parts_with_hygiene` does alignment-first routing,
   `product_shape`, selection of meshed representations, ordered `rep_items`, annotation exceptions,
   raw-frame construction, mapped parts, like-frame merge, single-item instancing eligibility,
   source hygiene and final placement. Empty and error returns are part of the contract.
2. `process_element_with_submeshes_impl` first tries material-layer slicing, then representations. A
   texture candidate is attempted before raw/untextured work. Failure falls through; a textured
   result uses index-only hygiene because UVs parallel vertex positions. Keep submesh IDs and
   `ids_are_materials` distinct.
3. `router/mapping/submeshes.rs::SubmeshWalk` and
   `router/mapping/merged.rs::MergedWalk` own the distinct mapped-source control
   frames. They replace the previous recursive consumers and retain their different
   source-admission contracts. Do not erase that difference by merging everything into
   one mesh. The source is decoded before mapping transform discovery; cached-source lookup is
   reached after transform decoding, while a hit skips source-representation/item decoding. Nested
   maps have path-local cycle/depth policy and conditional dropped-source diagnostics.
4. `textured.rs::process_representation_map_with_texture` is the type-product map path. It is not
   ordinary product representation filtering: non-Body type maps are still walked; only loss
   counting is gated. MappingOrigin must be applied in the same order as now. `plan_type_geometry`
   remains the sole SuppressInstanced/EmitTagged decision.
5. `frame_parts.rs::{FrameParts,SourceParts}` preserves the order of first compatible frame groups.
   `processing.rs` keeps raw versus RTC-applied accumulation separate. The origin, local bounds,
   rtc_applied, local_to_world and instance metadata are geometry data, not reconstructable from a
   positions array afterward.
6. `voids/mod.rs::process_element_with_submeshes_and_voids` tries layers before opening lookup, then
   materializes an untextured, non-instanced host with index-only hygiene. It builds opening context
   only after a nonempty host. `process_element_with_voids_parts` has its own merged-parts path.
   `build_void_context` classifies/processes openings, merges compatible cutters, then conditionally
   captures rectangle and bool2d source data. `apply_void_context` performs established conditional
   numeric strategies, repairs and exact-kernel fallback. Preserve consumed-host state and
   distinguish a valid empty subtraction from a failed attempt.
7. `voids/representation.rs::opening_requires_subtraction` conservatively excludes only proven
   Reference-only openings. Unknown/malformed/empty/over-budget data still enters the cutter path.
   This source-only precondition must not be replaced by an eager generic unsupported verdict.
8. `instancing.rs::{mapped_source_single_item,ensure_shared_mapped_source}`, `mapped_item.rs`,
   `item_dedup_cache.rs`, `diagnostics/{processor_failures,unsupported_items}.rs`, and
   `diagnostics_recording.rs` carry source/template eligibility and claim state. A mapped cache hit,
   failed/truncated source, multi-frame source and true single-source template have different
   contracts.

## Mapping-control implementation milestone

The mapped-source continuation now owns its frame stack, decoded source payloads,
transforms, path membership, item cursors and source-loss counting decisions.
Short-lived work scopes restore caller policy; no diagnostic guard is retained
in a frame. Merged and submesh modes retain their distinct cache/admission order,
error cleanup, repeated occurrences, instancing and appended-range transforms.
Targeted mapping tests pass, including malformed cache hits, source claims,
reentrant policy and sticky error-path admission. Full combined native/browser,
scene, resource and performance qualification remains pending.

The current mapping depth/path guards preserve prior admission but do not bound
acyclic expansion. Repeated mapped children can double real occurrence output at
each level; merged-source caching still permits exponential buffer growth.
The exact-kernel budget covers CSG, not this expansion. A coherent resource
contract must charge reached work and checked mesh/UV/part/template bytes before
allocation, preserve legitimate repeated occurrences, and report refusal without
partial-success or degraded-cache publication. No arbitrary smaller mapping cap
was introduced by this control extraction. Resource-bound qualification remains
open; the lexical reference-walk check cannot prove it.

This is control ownership over reached live decoder/router work. It is not yet
complete decoder-independent source lowering, a transported model context, a
cache-effect transaction, or a retained-engine execution plan. The command design
below remains required for the complete replacement.

## Proposed command and continuation schema

Use a single canonical `ProductProgram` continuation under the existing private product work
protocol. It owns an explicit stack and resource slots; commands are issued only when reached. There
are two explicit phases of an operation, rather than an object containing a decoder callback:

```
SourceStep { source_key, operation_role, cursor, path_state, context_stamp }
    -- authenticated source adapter, reached reads only -->
ReadyOperation { frame_policy, typed_payload, output_slots, evidence_scope }
    -- numerical executor -->
OperationResult { typed_value, source_and_execution_reports, effect_receipt }
    -- same continuation resumes --> next SourceStep or assembly
```

`SourceStep` is a finite tagged cursor, not a closure or copied IFC text. First useful cursor tags:
ProductShape, NextRepresentation, NextItem, TryLayered, TryTexture, EnterMappedOccurrence,
ProbeMappedCache, NextMappedSourceItem, FinishMappedSource, PlaceElementParts, ClassifyOpening,
BuildOpeningGeometry, CaptureRectCut, CaptureBool2d, ApplyOpeningContext. Boolean/CSG frames should
become child continuations retaining their present role/path/budget context, not generic binary
nodes.

`ReadyOperation` variants reuse actual owned constructor plans; others contain owned f64
placement/mapping transforms, a source-hygiene policy, a texture plan with admitted index/UV
payload, numeric layer-slice data, or already-prepared opening/cutter operation data. Meshes are
legitimate transient result slots and numeric input slots. They are not a substitute for source
recipes. No `Mesh`-containing source plan, callback capturing a decoder, or untyped request to run
the old whole pipeline qualifies as completion.

Continuation examples:

* `AfterTextureAttempt`: successful textured result bypasses later raw source reads; refusal resumes
  the untextured branch.
* `AfterMappedSource`: owns current source/item cursor, source-loss scope, ordered source-part
  accumulator and transform. It reaches the next source child only after the current child returns,
  keeps repeated occurrences, and does not globally suppress a DAG repeat.
* `AfterHostParts`: an empty host avoids opening context reads exactly where the old path did. A
  nonempty host reaches opening classification in original index order.
* `AfterOpeningContext`: one owned transient context fans out over ordered host submeshes; numerical
  application never re-decodes every opening per submesh.
* `AfterAttempt`: preserve current Primary/VoidedParts/PlainParts outcomes, annotation terminal
  refusal, consumed-host terminal success and precise retry-discard/final grouped diagnostic drains.

A critical timing detail: `representation/mod.rs::product_shape` currently resolves the whole
representation reference list before selection/execution; `rep_items` resolves the whole item list
before any item in that representation is evaluated. Preserve each bulk-list admission as one source
step. Replacing either with one-at-a-time decode would allow earlier items to execute before a later
malformed reference that currently aborts the list. Conversely, do not bulk-lower all item
descendants: their nested reads remain conditional. `process_element_with_voids_parts` builds the
opening context after host parts even if those parts are empty; only the submesh path has the
earlier empty-host return. Keep separate cursor states for those cases.

Source read reports belong to the reached admission, including malformed/unrepresentable real
evidence. Dormant or skipped branches contribute no reports. Empty flags, mark-relative boolean
diagnostics, current element budget and operation role travel with child continuations. No result
memo under mutable numerical budgets. Queue/work bounds must act and report and preserve existing
conditional admission; adding an unrelated small eager bound would reject previously admitted
source.

## Full mesh and occurrence result contract

Keep the current `Mesh`, `SubMesh` and `SubMeshCollection` semantics initially. A typed result
envelope must retain positions/normals/indices, f64 origin, local bounds, rtc_applied,
local_to_world, instance metadata, submesh geometry ID plus its ID-domain discriminator, optional
UVs and texture attachment. Keep ordered parts and optional RawInstanceOccurrence records separate.
Preserve closure and geometric hash input order before final site rotation, fixed-color treatment of
meshes and occurrences, and degenerate-drop retraction. Hashing an instance-only output must not
silently become equivalent to an empty product.

Mapping occurrence commands own source reference and transform; reusable definitions own source
geometry only. MappingTarget composed over MappingOrigin, translation scaling, local transform,
canonical transform, world placement and RTC conversion remain separate named steps. Cache/source
identity is scoped to the loaded model and revision, never a bare express ID across models. The
document's object-local definitions can receive accepted reusable source results only after this
contract is qualified; do not bake product placement into a boolean definition.

## Owned versioned model context, once per loaded model

The current context inputs are all borrowed immutable maps during a producer call; the mutability is
in their callers and persistent execution stores:

* `processing/processor/jobs.rs::process_entity_job` receives prepass maps, unit and angle scales,
  quality, RTC, optional site rotation, shared mapped/content caches and instancing policy. Native
  workers currently recreate routers and move point/placement caches into and out of decoders
  through WorkerCacheGuard, including error/panic paths.
* `wasm-bindings/src/api/gpu_meshes/batch.rs` reconstructs void/material arrays per call and obtains
  cached style, palette and texture indices. These can differ between batch invocations on the same
  source bytes. Caller-supplied overrides must not be frozen invisibly on first load.
* `appearance/canonical.rs` is another real assembly consumer of MeshProductionContext. Include it
  in integration, rather than coupling context ownership to the browser API alone.

Introduce `Arc<ModelContextSnapshot>` held by each owned job/program. Snapshot identity includes
model/load identity and an explicit context revision. It owns void_index, geometry_style_index,
indexed_colour_full, element_material_colors, texture_index and site-local rotation. Store map
values directly once (or shared Arcs for large independently revised indices); each product holds
one Arc plus small per-job metadata/color/ordered map state. Type-map classes remain paired with
their ordered IDs; an immutable Arc slice plus per-product cursor can avoid cloning that list across
commands without reclassifying it. Do not clone five maps per request, and do not build an Arc by
deep-cloning an existing borrowed context per element.

Build a snapshot at the existing model prepass boundary, with a deliberate replacement/update API
for browser batch overrides. Split configuration into source geometry policy (units including
admission error, angle scale, tessellation quality, RTC, registry identity/generation,
instance/template policy) and presentation snapshot. Exact invalidation keys depend on what each
cache actually stores: raw source geometry should not be keyed on unrelated color edits, while
palette/texture/hygiene-sensitive results require the relevant revision. Continue to validate
complete request context at acceptance even when individual caches use narrower keys.

Mutable `ModelExecutionStore` is separate from immutable snapshot: worker point/placement/entity
memoization; source meshes; structural dedup entries; template publication; diagnostic-claimed and
unsupported-source-claimed sets; host-consumed and grouped diagnostic logs. An Arc around one giant
mutable context and a lock across meshing would recreate existing nested-join deadlocks. Locks
protect only lookup/claim/publication. Never hold a lock while constructing a source, invoking an
extension, running rayon or joining a scoped worker.

## Cache and extension compatibility

Source geometry reuse is conditional: truncated and multi-frame sources cannot publish as ordinary
single-source cache/template entries. Keep source-loss claim identity separate from geometry mesh
identity and content dedup diagnostic claims. Preserve current per-pass first-claim semantics,
including the documented omission of diagnostics on some cache hits; fixing that omission is a
separately evidenced behavior change, not incidental migration cleanup.

Do not move existing cache/claim side effects to arbitrary reply acceptance: today they occur inside
authenticated numerical work before assembly. That can change racing claim winners and diagnostic
ordering. First make effects explicit receipts owned by the leased execution store, applied at the
same reached point, and ensure a rejected reply cannot replay them. Full transferable effects
require a separately specified commit protocol.

Custom registrations must retain actual dispatch and mutable-decoder behavior. An explicit
`ExtensionCall` command executes against the leased live owner and records its real registration
token; it cannot claim decoder-independent replay. Existing ordinary nested router calls, canonical
lexical children, fresh owner halves, scoped-thread decoder borrows, callback cache/unit maintenance
and final diagnostic hooks all remain supported. Planning and final drains are reached callback
boundaries too. Sparse registry traces remain sparse; contextual work tags do not prove complete
provenance.

## Smallest production source-admission seam

The relevant implementation homes are the
[representation decoder and selection contract](../../rust/geometry/src/representation/mod.rs),
[canonical router loops](../../rust/geometry/src/router/processing.rs),
[mapped-source consumer](../../rust/geometry/src/router/mapped_item.rs),
[texture and type-map consumer](../../rust/geometry/src/router/textured.rs), and
[host opening paths](../../rust/geometry/src/router/voids/mod.rs).

The first extraction can replace the duplicated representation admission in
`router/processing.rs::process_element_parts_with_hygiene` and
`process_element_with_submeshes_impl` without moving their numerical branches.
It should live beside `representation/mod.rs`, where `ProductShape` already owns
its decoded representation list and `Select` is the canonical filter.

Proposed crate-visible types and methods:

```text
RepresentationCursor::admit(element, decoder, Select)
    -> Result<Option<RepresentationCursor>, ShapeError>
RepresentationCursor::next_representation(decoder)
    -> Result<Option<AdmittedRepresentation>, ShapeError>

RepresentationCursor {
    product: owned DecodedEntity,
    shape: owned ProductShape,
    next_representation_index: usize,
    selection: Select,
}
AdmittedRepresentation {
    representation: DecodedEntity,
    items: Vec<DecodedEntity>,
}
```

`admit` calls the existing `product_shape` at precisely the old call site,
after alignment or material-layer early returns. It owns the entire decoded
representation list. The cursor uses the existing selection predicates and
has-direct-geometry rule; it does not invent a second representation classifier.
`next_representation` admits one selected representation's entire `rep_items`
list before returning it. The cursor preserves source order and existing error
text. Annotation fill-only classification stays at its existing reached point
after the item-list admission; it need not become representation-layer policy.

Both production loops consume this cursor and delete their duplicated source
admission logic. Empty shape outcomes remain consumer-specific: merged parts
returns its existing empty mesh, while submeshes returns an empty collection.
The cursor carries no borrowed router/context and no decode callback. It owns
source selection state, but its next source admission still needs a decoder.
That limitation is explicit: this extraction is a real control seam, not a
complete executable construction plan or a family cutover.

Behavioral tests should distinguish a malformed later representation reference
from a malformed item reference in a later selected representation. The former
fails the initial bulk admission before item work; the latter fails only when
that representation is reached. Repeated references preserve occurrences,
unselected representations do not decode their item lists, and the same cursor
contract serves ordinary and submesh consumers. Test through real decode and
production behavior rather than source-text assertions.

The next phase turns each admitted representation into the typed item and mapped
continuations described above. This avoids extracting an entire legacy product
call as an opaque command. It also gives one shared source boundary before the
larger nested-map, texture and opening state machines are migrated.

## Implementation phases and whole-platform cutover

Implement the ordinary product representation continuation first, supporting both submesh and
merged-parts consumers, annotation/raw-frame cases, nested mapped sources, texture fallback and
representation-map TypeProduct entry through the same typed source executor. Move
`FrameParts`/`SourceParts` and transform/hygiene application into decoder-free numeric commands
without changing their arithmetic/order. Plug the existing constructor lower/evaluate and boolean
continuation child frames into this reached loop; preserve direct custom dispatch as an explicit
leased command. Production entry points should all drive this common continuation when their
migration is qualified; delete superseded loops in the same change, rather than retain a second
traversal.

Then complete layer/opening continuations in that same architecture and qualification track. Extract
source-free numeric opening operations first, then replace reached source capture with typed
admissions in exact existing order. Product retries/appearance assembly stay in the existing shared
product session. This sequence is implementation sequencing, not authorization to activate only easy
families or declare the full goal achieved while openings/types/extensions still take unrelated old
walks.

Required evidence before broad cutover: all current consumers; real
mapped/multiframe/georeferenced/textured/layered/void/type models; exact
source/error/read/diagnostic-order invariants; repeated source/cache-hit and concurrent-claim cases;
alias/custom/nested/scoped-worker callbacks; cancellation/panic/poison rules; x86/arm/WASM
deterministic geometry and FFI frame outputs; full Rust/consumer/ratchet gates; interleaved
end-to-end worker-pool time plus retained and peak RSS. No speed, memory improvement, full
provenance, async transport, cancellation or remote readiness is claimed by this design.

The [scene qualification design](geometry-platform-scene-qualification.md) and
[historical ownership-layer receipts](evidence/geometry-platform-scene/) define
the stronger presentation comparison to repeat for this implementation. Geometry
fingerprints alone omit channels this migration must preserve.

The [owned model-context design](geometry-platform-model-context.md) specifies
per-chunk/batch snapshots, context/source revisions, the unchanged borrowed
compatibility API and source/replacement-texture appearance contexts. Its
consumer integration must be qualified together with this source-control layer.
