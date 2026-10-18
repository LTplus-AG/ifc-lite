<!-- SPDX-License-Identifier: MPL-2.0 -->
# Product work/reply boundary: required ownership changes

The canonical producer now uses private typed request/execute/accept transactions
for its reached product stages. This is a synchronous internal boundary. It does
not expose remote or asynchronous execution, cancellation, transport identities
or a retained-engine scheduling API.

## Implemented boundary and current limits

`ProductExecution::request` selects one reached stage and issues a unique
session/sequence/kind ticket. `execute` checks that ticket before router work,
reserves its decoder and router, and returns a typed numerical payload with an
owner stamp and contextual emitter tag. `accept` checks the outstanding ticket,
executed state, payload variant, contextual emitter, captured registry emitter
identities, and current owner/configuration identities before canonical assembly.
Rejected replies return their unconsumed packet; they do not advance presentation,
drain diagnostics or publish geometry. Duplicate numerical execution is rejected
before it can repeat callbacks or cache effects.

Each decoder/router has an address-independent identity, configuration generation
and exclusive owned reservation. Identity/generation stay inline; shared
reservation state is allocated lazily when the owner is first leased. Planning
reserves owners because classification can reach source data. A root planning
reservation ends before dormant control can transfer to a compatible destination;
first numerical admission binds its live owners through final publication.
Independent resumable products cannot borrow an occupied owner.

Validated synchronous `ExecutionWork` separates trusted callback mutations from
pending-reply acceptance. A reached callback may clear caches, reseed units or
perform existing owner configuration work. Only normal executor completion can
commit a fresh generation read from the actual same live owner. Unwind does not
commit. Configuration changed while a reply waits invalidates it without
releasing the reservation; acceptance never refreshes ownership from a reply.
A replacement decoder/router or dropped owner always rejects, even for identical
source bytes and express ids.

Canonical synchronous callbacks can produce lexical child products. Ordinary
capabilities remain thread-bound; admission searches every live lexical ancestor,
innermost first, for each actual supplied owner half. Matching halves inherit
capabilities, while every independent half acquires a strict root reservation.
An occupied independent half rejects before child geometry. Any inherited half
binds the complete child to its ancestor epoch, and the canonical driver
completes it inside the lexical call. Private resumable siblings remain strict.

`ExecutionWork::source_borrow_scope()` supplies a separate decoder-only borrow
authority, discoverable through the actual `&mut EntityDecoder`. It preserves a
custom callback lending that decoder to a scoped worker with a fresh compatible
router, producing a canonical child and joining before the parent resumes. The
outer Rc router remains on its thread. Source authority checks every ancestor's
liveness and expires with ancestor work; the short-lived source scope restores
enclosing authority on success or unwind. A waiting reply has no such authority.
This does not relax router capability thread checks, release root reservations,
or permit asynchronous descendants or independent resumable siblings.

The source scope does not propagate exact-budget, pending-diagnostic or census
TLS to the worker; existing worker-local behavior is retained. Ordinary direct
geometry calls remain possible within their product under executor discipline.
Identities are local to one process or WASM instance, not network credentials or
a cross-instance model-generation protocol.

The canonical driver supplies the same borrowed production context throughout
its synchronous run. The new owner stamp does not version or serialize those
style, texture, opening and palette maps. Owning/versioning that model context is
still required before exposing work to another scheduler or a remote emitter.

Short-lived exact-budget, degenerate-count and pending-diagnostic scopes restore
ambient TLS on every work/assembly return or unwind. Product-owned pending state
isolates curve caps, face refusals and legacy pending-mapped CSG records. First
live admission deliberately adopts only the ambient pending-mapped channel to
preserve the existing producer contract. Curve/face reports belonging to the
caller remain ambient. Original abandoned-primary and final CSG drain points
remain authoritative; registry processor logs are not drained per packet. Final
publication republishes remaining product curve/face reports for existing caller
drains. The final processor drain observes the restored caller triangle-order
mode, preserving the original producer boundary; product mode is not installed
around that drain. A synchronous unwind delivers its pending reports to the caller, restores
ambient scopes and poisons the continuation. This is not a late-reply or
cancellation terminal-delivery protocol.

Registry entry capture records ordered unique identities of processors actually
entered, distinguishing lazy built-in instances, configured built-ins and custom
registrations. Aliases of one registration share a token. Metadata lookups emit
nothing. Captured tokens and contextual dispatch tags are different evidence:
direct constructor/boolean-factory/contextual paths can bypass the registry.
The sparse trace does not certify complete source lineage, analytic authorship
or arithmetic precision. The executor retains its expected trace until acceptance;
a reply cannot substitute another trace to change its declared emitter evidence.

Router diagnostic channels, consumed-host state, source claims and local/shared
cache effects remain under the exclusive executor lease. Existing usable source
cache insertions may occur during validated numerical execution; acceptance does
not replay them. They are not yet detached owned reply envelopes. The required
remaining contracts below describe how to make that broader transition without
changing grouping, attribution, retry behavior or template publication.

[Corrected-source qualification](evidence/geometry-platform-work/validation.json)
records 5,730 native passed invocations with zero failures, Clippy, fresh WASM
checks, the installed local Python consumer, real-file replay and six measured
geometry comparisons. Fixture skips and field omissions remain explicit. Earlier
product receipts qualify their recorded source only. The rejected initial
boundary receipt preserves the actual allocation regression; corrected-source
measurements and hashes are separate. This qualifies the private synchronous
ownership layer, not full presentation identity or whole-platform cutover.

Final processor failure hooks run inside the same validated lexical ownership
contract using a shared-decoder trusted scope. They can produce synchronous child
geometry with a fresh compatible decoder. Finalization preserves the restored
caller triangle-order mode and uses panic-safe pending-report delivery; it does
not reinstall the product's triangle-order policy.

## Current mutable ownership that a lease must cover

`GeometryRouter` in `router/mod.rs` owns these distinct categories:

| Category | Actual fields and constraints |
| --- | --- |
| Processor instances | `processors: ProcessorRegistry`, containing lazy `OnceCell<Rc<dyn GeometryProcessor>>` defaults and custom/configured overrides. Processor instances carry failure logs and are not Send. Draining must not instantiate unused families. Custom aliases can share one Rc; drain once or preserve today's empty-second-drain behavior. |
| Router diagnostic accumulation | `csg_failures`, `classification_stats`, `host_opening_diagnostics`, `rect_fast_stats`, `layer_slice_diag`, `content_hash_oversized_ref_drops`, plus `unsupported.counts`. These have different merge and retry policies. |
| Semantic control state | `voids_consumed_hosts`, `preserve_triangle_order`, `unsupported.scope`, `unsupported.sources_recorded`, `instanced_sources_materialized`. These cannot be treated as disposable logging. |
| Local memoization | `mapped_item_cache`, `geometry_hash_cache`, `content_sig_memo`; local cache hits alter which source walks and diagnostics occur. |
| Shared cache handles | `shared_mapped_item_cache`, `item_dedup_cache`, `shared_brep_signatures`. These are shared across routers and must retain current publication and diagnostic-claim semantics. |
| Fixed execution configuration | `unit_scale`, `length_unit_refused`, `rtc_offset`, `local_frame_enabled`, `material_layer_index`, `tessellation_quality`, `skip_small_cuts`, `output_instancing_plan`, `indexed_colour_split_ids`, `instancing_batch_local`. A pending request must see the same configuration when its reply is accepted. |

`ProcessorRegistry::values()` deliberately visits only initialized defaults. `take_csg_failures()` additionally drains every processor log and the thread-local pending-mapped channel; it is not just a map swap. A reply adapter that swaps only `router.csg_failures` loses records or steals another operation's pending failures.

`unsupported.sources_recorded` persists across `take_unsupported_items()`: once means once per source per router, not once per product or once per model. `unsupported.scope` is a lexical stack whose innermost decision wins. Snapshotting/restoring the counts while resetting the source set would inflate drops. Moving the stack into a reply without its walk would incorrectly suppress or permit subsequent drops.

## Concrete diagnostic envelope and retry ownership

Use an internal typed product diagnostic accumulator, distinct from the existing public diagnostics structs. Its ownership must include:

- The CSG map of `Vec<BoolFailure>` including the existing unattributed product-id-zero bucket. Preserve attribution; a session id does not authorize rewriting a failure's IFC product attribution.
- `ClassificationStats` (`rectangular`, `diagonal`, `non_rectangular`): additive across reached classification work.
- `FxHashMap<u32, HostOpeningDiagnostic>` with `host_type`, ordered `openings`, `csg_failure_count`, `first_failure_label`, `tris_before`, `tris_after`, `rect_boxes_processed`, `host_bounds`.
- `RectFastStats`: additive fired/openings-cut/defer counters.
- Ordered layer-slice records `(element_id, reason)`.
- Unsupported-item counts by IFC type, while retaining source-claim state in the leased router.
- Oversized-reference drop count, while retaining signature memo/cache state in the leased router.
- Reached consumed-host decisions, available to the product continuation before it chooses the plain fallback. An empty mesh alone is insufficient: a consumed host is terminal successful emptiness.
- Pending curve-cap/face-refusal reports and pending mapped boolean failures, isolated from the caller's pre-existing TLS on every synchronous work slice.
- Census records with an explicit measurement-owner policy, described below.

Host diagnostic merge must match current writers: retain the first nonempty host type, append opening records in reached order, add failure counts, keep the first failure label, and replace cut-effect fields with the last reached cut-effect record. `rect_boxes_processed` is replaced with the current cut-effect value, not summed as though it were RectFastStats. Prefer routing ordered diagnostic events into the same existing recorder methods rather than adding a second hand-maintained field merger.

Retries do not use one blanket transaction rollback. Today's primary-submesh retry discards its CSG failure range because the next strategy repeats those cuts; classification, host-opening, layer, unsupported and other router reports are not blanket-rewound. The new envelope must carry channel-specific checkpoints. Preserve existing behavior first; any desired change to duplicate classification or host diagnostics is a separately measured behavior change.

At lease admission, save rather than adopt ambient router/TLS reports. Seed the product's CSG accumulator according to the canonical producer's current pre-existing-router-failure behavior, then prevent other sessions from draining that same owner. On every reached operation, capture its processor logs and pending TLS, including error paths, before restoring the caller's pending TLS. On panic, retain or deliver an explicit failed-work terminal packet; never silently clear existing caller reports. The existing `diagnostic_capture` helper currently handles curve/face reports, not all channels listed here. The pending-mapped TLS has no producer today, but its public drain still makes it part of the isolation boundary.

Do not reinterpret `decoder.refused_record_ids()` as per-work delta attribution. It is cumulative. Carry directly refused source-record ids where typed source errors identify them, and label any cumulative snapshot accordingly. A shared decoder lease also owns caches, strict-real mode, unit caches and the input/index identity; a reply cannot be accepted against a replacement decoder merely because product ids happen to match.

### Census and other global measurements

`csg/mod.rs` stores CSG census operations in process-global `Mutex<Vec<CsgOpRecord>>`; records only contain op and triangle counts. `reset_csg_census()`/`take_csg_census()` cannot isolate overlapping requests or attribute replies. Draining it at a product yield would steal other routers' operations. Preserve its current whole-measurement ownership until a scoped sink exists.

Optional `CsgCensus` and `CsgCensusContext` now provide an owned measurement sink at the existing `record_csg_op` boundary alongside unchanged global aggregation. Real-geometry tests cover nested explicitly propagated Rayon contexts. No current faceted-triangulation worker emits CSG records. Product work does not automatically allocate a second census buffer. For attributable asynchronous work packets, bind a sink to the request and propagate its captured context to every worker task that can record operations. Keep the old process-wide census consumer as a run-level aggregator; do not add fields to the existing public record just to carry private scheduling tokens. Qualify nested Rayon recording explicitly. A TLS-only owner token without propagation does not establish ownership on independent workers. The process-global budget peaks remain calibration maxima, not additive product/reply counters; resume must not reset them. Optional plane-weld diagnostics likewise have target/feature-specific aggregate collection and must not be claimed as isolated product data without an explicit owner.

## Lease and acceptance barriers

The implemented internal `ProductOwner` holds decoder/router execution reservations, with no mutex or TLS guard retained across a yield. Extend that boundary before external scheduling: It identifies input/model generation, router instance/configuration generation, decoder/input generation, product session and next work sequence. External registry replacement or quality/configuration changes while a reply waits, input replacement and lease completion invalidate pending replies. Only validated synchronous work may commit its own same-owner callback mutations; reply acceptance may not do so. Do not identify a lease by raw express id alone.

Minimum coherent scheduling policy: one outstanding work item per product, one exclusive root product lease per router/decoder owner (with synchronous lexical descendants), and one consuming presentation continuation. The executor can run another owner's product while a lease waits, but cannot lend the same warm owner to another product. Rc processors remain on their owning executor. Shared cache locks remain brief get/insert locks; they must never span numerical execution, nested Rayon joins, presentation, or a pending reply.

Every request/reply carries the exact session/lease generation, sequence and reached stage. Validate the typed variant and emitter before accepting it. Consume a reply once; a duplicate, out-of-order, stale-generation or wrong-stage reply must not append diagnostics, advance the strategy, publish templates, or mutate presentation state. A failed/cancelled session is terminal; do not accept a late successful packet. Keep the current internal poisoned-session rule: an unwound slice has no live scopes and cannot finish publication.

The budget `ElementState` and degenerate `ElementState` are product-owned. Install them only while executing a synchronous slice, and save them before returning. Triangle-order state and unsupported-source lexical scopes must also close before yielding. Do not move an active `ElementScope`, RefCell borrow, processor Rc, unsupported-source guard or cache lock into a reply. The current product state supplies exclusive decoder/router reservations and short-lived scopes; it does not yet own/version the complete model context or transport diagnostic/cache effects.

## Typed work and emitter-tagged payloads

The private `advance` now drives request, executor and accept/assemble internals using the existing reached stage set. These implemented packet variants retain the current numerical builders:

1. Type-map work carries map id and existing geometry class; reply contains the existing frame/texture `TypePart` sequence and preserves map order.
2. Primary work explicitly distinguishes textured submeshes from voided submeshes and carries the planned layer class. Reply carries `SubMeshCollection`, including `ids_are_materials`, submesh geometry ids, UVs, texture attachment and empty instance placeholders. Empty placeholders with instanceable metadata are successful occurrences, not an empty-work retry.
3. Voided-parts work replies with geometry, consumed-host terminal success, or retry. Snapshot the consumed-host decision in the reply while still under its owner lease; do not query whichever router happens to be present during accept.
4. Plain-parts rescue preserves previous void-failure evidence and replies with frame parts. Textured annotation refusal remains terminal rather than becoming a generic retry.

Use a closed internal emitter tag generated at the actual dispatch/creation site: built-in family plus execution-policy generation, custom registration identity/generation, mapped-template materialization, or a specific contextual opening/layer path. Tag both payload and diagnostic/cache-effect envelope with the same work ticket. Do not infer emitter from mesh contents, IFC type alone, a cache hit, or the set of supported types a custom processor advertises. Do not equate a built-in family tag with an authored analytic representation or a particular arithmetic precision guarantee.

The packet remains a numerical/presentation transport value; it is not an authored construction plan. Preserve every existing `Mesh` frame field (`origin`, `rtc_applied`, `local_bounds`, `local_to_world`, `welded_in_object_frame`, plane tags and instance metadata). Native or alternative emitters must supply a qualified frame contract before a packet reaches canonical assembly. Canonical color/style/material inference, palette splits, outward orientation, UV-aware welding, degenerate cleanup, fixed display colors and hashing continue in the existing assembly helpers exactly once. Keep constructor/source identity, material-id semantics and template identity distinct in packet types.

## Cache and template publication barriers

Do not clone and roll back whole caches per product. Preserve the current points where usable immutable geometry becomes shareable:

- Mapped source cache publication requires a single source frame, nonempty positions, clean current element budget and no truncated source walk. Multi-frame sources stay distinct frame parts. Shared insertion occurs outside the meshing call and outside any held join lock. The local fallback deliberately caches empty geometry; making its rule match the shared cache would change behavior.
- Item dedup keys identify local pre-placement, color-free item geometry. Its independent `diagnostic_claimed` set chooses one diagnostic winner among racing misses; it never gates numerical construction. A cache hit currently does not replay that operation's failure payload. Preserve that qualified behavior until deliberately changed.
- `instanced_sources_materialized` chooses the first reached template within a batch. A work request must not mark it committed before materialization/publication completes. Represent reservation, completed source publication and occurrence emission separately, so cancellation cannot leave every later occurrence as a placeholder with no usable template.
- Native global mode uses the configured deterministic template item id; batch-local mode chooses first reached materialization. Preserve both policies and indexed-color/multi-item/nested-map exclusions. The source cache used by `ensure_shared_mapped_source` is the recovery resource when a template occurrence never materializes.
- Immutable source-cache publication can remain reusable even if later product presentation fails, provided all source admission guards passed and there is no unqualified per-element degradation. Product output/template selection and job diagnostic emission need their own once-only commit. A blanket rollback of successful source geometry is neither necessary nor equivalent to current behavior.

At the first boundary, keep complete router work inside one executor call. It may perform existing valid source-cache insertions before returning a numerical packet, but only that executor owns those effects. Do not move individual insertions into an untrusted reply handler. Before allowing truly cancellable or remote emitters, introduce explicit pending materialization reservations whose failure/drop releases the reservation without removing a successfully published source from another owner.

## Minimal coherent implementation and qualification

The implemented synchronous boundary combines decoder/router reservations, typed stage tickets, pending-TLS isolation, sparse actual registry-entry identities, contextual emitter tags and acceptance checks through `produce_element_meshes`. Complete router diagnostic capture/merge ownership, model-context generations, template reservation/cancellation and remote terminal delivery remain required. Preserve old stage ordering while extending this same boundary; no second producer is authorized.

Qualify the boundary using actual canonical production: all current type-map and annotation terminal cases; consumed-host versus empty-rescue; textured/palette/material-layer collections; instance-only success; warm mapped-cache hit and total-loss source counts; first template failure followed by later materialization; stale/duplicate/wrong-emitter reply rejection with no cache or diagnostic side effects; two router owners with pre-existing pending reports; error/panic restoration; shared-cache racing misses with one diagnostic winner; caller exact/tally state and thread migration; and tagged census ownership across nested worker execution. Compare complete packet/frame/style/hash output plus all diagnostic channels to the direct synchronous path. Finish with full workspace tests, clippy, wasm qualification and interleaved base/branch end-to-end measurements with byte identity.

Only after this passes should work/reply cross an asynchronous or native-worker boundary. The later fine-grained emitter split still needs owned contextual opening/layer/mapping operations; the current partial construction graph cannot replace those source/router contracts wholesale.
