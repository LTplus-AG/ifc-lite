<!-- SPDX-License-Identifier: MPL-2.0 -->
# Owned model context for production execution

Native chunk jobs, browser geometry batches and appearance evaluation now use
immutable owned model-context snapshots around the existing canonical product
transition core. Qualification for these source changes is pending. Earlier
[work evidence](evidence/geometry-platform-work/) and
[scene comparisons](../../tools/smlib-evaluation/scene-comparison/) retain their
original source scope; they do not qualify this migration.

This extends the [product session](geometry-platform-product-session.md) and
[synchronous work boundary](geometry-platform-work-boundary.md). It does not
expose an asynchronous scheduler, transport protocol or retained kernel API.
See [capabilities](geometry-platform-capabilities.md) and
[next steps](geometry-platform-next-steps.md) for remaining exclusions.

## Public compatibility and the common transition core

`MeshProductionContext<'a>` retains its six public borrowed fields and downstream
struct-literal API. `produce_element_meshes` retains its signature and completes
synchronously against those borrows. It does not recover ownership by copying
caller maps or impose a new lifetime parameter on dormant owned sessions.

The additive `OwnedMeshProductionData` contains corresponding Arc fields for
openings, geometry styles, full palettes, element material-color lists and
textures, plus an optional `Arc<Vec<f64>>` site rotation.
`ProductionModel::snapshot(data)` returns an
`Arc<OwnedMeshProductionContext>`. `borrowed()` projects the unchanged public
view. `produce_element_meshes_owned` returns
`Result<ProducedElementMeshes, ProductionContextError>` and reports explicit
source invalidation as `StaleSource`.

The private `OwnedProductExecution` stores one snapshot Arc and drives the same
`ProductState` planning/work/assembly/finalization implementation as the borrowed
canonical entry. Later transitions receive no replaceable context argument.
Each product clones only that outer Arc. Component Arcs are assembled once per
effective chunk, batch or appearance revision; map entries, palettes and texture
bytes are never cloned per product.

Synchronous owned and borrowed canonical calls preserve custom callbacks using
same, mixed, independent or ancestor owner pairs. The existing explicit
mutable-decoder scoped-worker borrow remains joined before parent return, while
router capabilities remain thread-bound. A child callback may deliberately
supply a different borrowed context; the parent snapshot is not implicitly
inherited through TLS. Independent resumable siblings retain strict exclusion.

## Load, source and snapshot identities

`ProductionContextId` separates a process-local model load identity, source
epoch and snapshot revision. Two loads of identical bytes are distinct loads.
New snapshots of the same source do not mutate or expire old snapshots.
`ProductionModel::invalidate_source()` explicitly expires preceding source
epochs. Dropping the model handle does not invalidate retained snapshots.

Owned requests and replies bind the snapshot identity in addition to existing
session/sequence, runtime-owner, emitter and payload validation. A reply cannot
supply a replacement context or refresh an executor's configuration generation.
External owner changes while a reply waits still fail owner validation. Trusted
normal callbacks may commit their actual decoder/router mutations under the
existing scoped-work rules.

These IDs are local completion identities, not content hashes, network
credentials or cross-WASM-instance load identifiers. The existing load
orchestrator must supply any future cross-worker identity. Source/index
coherence and model/overlay revisions still need an explicit host contract before
remote execution is authorized.

## Native chunks and deferred styles

The native processor creates one `ProductionModel` per run. Each chunk snapshots
the existing opening/style/palette/material/texture Arcs and the once-per-run
owned site rotation before launching jobs. Jobs retain current skip admission,
strict decoder setup, unit seeding, per-worker cache guards, fresh routers and
shared numerical caches, then call the owned canonical driver.

Deferred styles keep their established timing: earlier empty chunks produce no
style replay. After the first nonempty chunk is emitted, the resolver replaces
the style Arc and emits corrective colors for already processed jobs. Later
chunks receive a new snapshot. Earlier geometry is not reprocessed or silently
restyled through a mutable snapshot. Type-geometry policy, native hashing-off
behavior, site-local gates and event order retain their existing consumer rules.

The native prepass router's material-layer index is still absent from fresh job
routers. The ownership migration does not copy that prepass configuration into
jobs. This existing native/browser difference needs separate behavior evidence
and a separate decision; context ownership must not silently change it.

## Browser batches and source lifecycle

`produce_batch` remains common to flat, instanced and partitioned outputs. Each
call snapshots the actual resolved cache values and moves that call's rebuilt
opening/material maps into Arcs. Later calls may supply different maps or omit
material fields; the first call does not freeze later overrides. `FromSource`
continues to delegate through the same batch implementation.

The existing style cache still stores a shared color/index tuple, with the index
now moved into an Arc at construction. The cached full palette map is likewise
moved into an Arc after its split-guard IDs are derived. These changes avoid
cloning whole maps when assembling a batch snapshot. Texture caches already
share their maps through Arcs.

The style cache's cheap `(length, first ID, last ID)` match remains unchanged.
Same-signature changed wire contents can therefore still reuse an earlier map;
this is a retained limitation, not a strong style revision identity. Snapshots
capture the actual selected map. This migration does not incidentally fix that
predicate, add revision-dependent numerical cache keys or change map precedence.

Installed finish maps are captured independently for each batch. The existing
`BatchFinishes` join still runs after canonical geometry, using that batch's
color map and actual decoder. Finish updates/clears, merge-layer settings,
quality, hashing and rectangular-opening settings retain their current per-call
selection. No join borrow or cache mutex survives a work boundary.

Existing source-byte replacement, index replacement (including rejection) and
`clearPrePassCache` boundaries invalidate production source authority. They keep
their previous cache and setter behavior: source bytes are still replaced
independently of index installation. The snapshot does not certify that an old
index and newly installed bytes are coherent. No new loader is introduced.

Public wasm-bindings Rust methods and JavaScript exports retain their original
synchronous signatures and batch ABI. They are thin shims over the same fallible
owned-context implementation. Each ordinary JavaScript batch constructs its
snapshot inside the synchronous call and completes before source/index/cache
setters run. The progress callback must not reenter the module. Independent
owned Rust sessions and `produce_element_meshes_owned` retain typed
`StaleSource` errors for explicit lifecycle invalidation; the synchronous batch
entry does not expose that resumable protocol.

An earlier candidate exported Result adapters and changed the raw return-frame
ABI despite preserving high-level JavaScript types. Its receipt remains
historical evidence of that rejected candidate. The restored source requires
fresh generated high-level and raw ABI comparison plus consumer qualification;
previous passing runs cannot qualify the correction.

## Appearance source and target revisions

The public `ResolvedPrepass` struct and its field types remain unchanged.
Appearance moves its completed production maps once into a private Arc-backed
`Styles` owner. Unused public prepass metadata is not copied. Repeated unchanged
source passes reuse one snapshot. The private cache uses an explicit source
identity; Arc equality only checks whether the actual texture component can be
reused, and never grants source authority.

Completed synchronous appearance passes release their style snapshots before
authored style edits. The private owner drops its cached context before editing
the uniquely owned style map, so this path does not clone a map per conversion.
The next pass creates a new immutable revision. The existing source texture
index remains shared across the planning session.

Source-to-target corner alignment still evaluates source textures first and
then the deliberately replaced texture map. The target gets a distinct snapshot
sharing the other map components; it does not overwrite the reusable source
snapshot. Replacement maps retain their existing selected-item scope rather
than implicitly merging all original textures. Retained faces, UV seams, source
color, placement/frame validation, layer-sliceable refusal and canonical failure
conversion retain their existing semantics. Ordinary and evaluated appearance
routers remain distinct policies feeding the same producer.

## Required qualification and remaining work

Consumer regressions exercise an empty initial native chunk followed by deferred
style replacement and corrective events; actual textured appearance geometry
with shared source maps and distinct target UV/texture revisions; and real WASM
batches with changing/omitted material and opening wires, changing finishes and
the retained style-cache collision behavior. Existing canonical callback,
scoped-worker, palette, layer, mapping, texture seam and frame tests remain
required. A constructor-only or pointer-only assertion is insufficient: shared
ownership evidence must accompany actual output geometry.

Before claiming this source state qualified, rerun native workspace tests,
all-target Clippy, real WASM and package contracts, excluded Python consumers,
public type compatibility and source-matched full-scene/performance comparisons.
Old receipts cannot be relabeled as current results.

Owned context does not complete router diagnostic/cache-effect ownership,
reservation/cancellation for templates, reply terminal delivery or model/overlay
revision coordination. No guard may cross an asynchronous suspension, and no
partial construction graph replaces reached production control flow.
