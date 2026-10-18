<!-- SPDX-License-Identifier: MPL-2.0 -->
# Owned product execution and synchronous work boundary

The canonical producer now drives one private, owned synchronous
`ProductExecution` in `rust/processing/src/element/session.rs`. The previous
execution orchestrator is deleted. Typed synchronous request/execute/accept
transactions are implemented internally; this is not a public async,
cancellation or retained-kernel API. New
[work qualification](evidence/geometry-platform-work/) is pending. Historical
[product qualification](evidence/geometry-platform-products/) and earlier
receipts retain their original source scope.

## Implemented ownership and control

`produce_element_meshes` constructs the session, advances reached stages to
completion and publishes once through `finish`. Reached router work produces a
typed reply before the separate acceptance/assembly step. Native and browser
callers keep this same producer. The constructor performs reached strategy planning
synchronously: progress, hasher configuration, indexed-color reachability,
representation/type selection and opening classification still consult the
canonical decoder/router before the first numerical advance.

The session owns the cloned job entity/metadata, selected color, triangle-order
policy, reached attempt state, owned type-map iterator, hasher, produced meshes,
raw instance occurrences and element accounting states. `plan.rs` now owns the
`PlanKind::TypeMaps` vector; `session_state.rs` owns its reached iterator and
`session_work.rs` admits the synchronous router work. Presentation borrows a
small `AssemblyJob` from those owned inputs and reuses the existing type/submesh/
fallback assemblers. No separate style resolver or model loader is introduced.

The owned state contains no decoder/router borrow or active thread-bound guard.
Planning temporarily reserves both owners, preventing an independent resumable
product from consulting a worker already reserved by another product. A root
planning reservation then ends, so dormant state transfer before numerical work
remains supported under the compatible-context contract. First execution, or
finish for a job with no numerical work, binds the live owners through
publication. Stable identities are inline; shared owner reservation state is
allocated lazily when admission is requested, preserving the warm unleased
construction allocation contract.

Existing synchronous canonical callbacks can produce lexical child products.
Ordinary capabilities remain thread-bound. Admission searches all live lexical
ancestors, innermost first, for each actual supplied owner half. Matching halves
inherit capabilities; mixed pairs reserve each independent half normally, and
wholly independent pairs acquire their own reservations. An occupied independent
half rejects before child geometry. Any inherited half keeps the complete child
bound to its ancestor epoch. Private independently resumable siblings remain
strict, including inside callbacks.

An explicit decoder-only source scope also preserves a callback lending its
actual `&mut EntityDecoder` into a scoped worker, constructing a compatible fresh
router there and joining the canonical child before resuming. The outer Rc
router stays on its thread. Source admission checks every live ancestor; the
scope restores enclosing authority on normal return or unwind, and descendants
expire when ancestor work ends. A waiting reply carries no source-borrow
authority. This authorizes no asynchronous child or independent sibling and
does not propagate budget, pending-diagnostic or census TLS beyond the existing
worker-local behavior. Direct router calls remain the executor's responsibility;
reservations do not make processors or caches movable.

Each reached executor/assembly call begins validated `ExecutionWork`. Normal
completion commits fresh identities read from the actual same owners, allowing
existing registered callbacks to clear caches or reseed units without falsely
rejecting their own work. Configuration changes while a reply waits still
invalidate it; acceptance never refreshes generations from a reply. Replacing or
dropping an input/router owner always rejects it. Panic closes work and child
capabilities without committing mutations and poisons the product continuation.

One outstanding request carries the private session identity, sequence and typed
stage. The executor binds owner/configuration and lease identities, selects the
contextual emitter at its actual dispatch, and captures ordered unique registry
instance identities from instrumented numerical entry points. Before assembly,
acceptance checks those identities, the pending ticket, expected payload and
emitter against executor-held evidence. A mismatched or stale reply is returned
unconsumed, without presentation or stage mutation. Context remains borrowed and
fixed by the private canonical driver; input/load revisions, frame negotiation
and remote trust are not supplied by this internal protocol.

| Stage / outcome | Implemented behavior |
| --- | --- |
| No representation | Complete without geometry, retaining the representation-less alignment exception in planning. |
| `TypeMaps` | Consume the owned map list in order; use existing textured map execution and shared type assembly/tagging. Type geometry stays excluded from product hashes. |
| `Primary` | Choose reached voided or textured submesh work through the current router. `RefusedAnnotation` is terminal. A candidate assembles once; mesh output or raw instance occurrences count as success. |
| Primary retry | Discard the abandoned primary attempt's CSG records at the existing retry point and advance to `VoidedParts`. Other router reports keep their existing ownership. |
| `VoidedParts` | `Geometry` enters shared fallback assembly; `ConsumedByOpening` is terminal empty success; `Retry` advances to `PlainParts`. |
| `PlainParts` | Run the existing plain rescue and fallback assembler. Preserve failures from attempted voids. |
| Complete / finish | Apply fixed display colors, final CSG drain and hash/bounds/volume/closure publication. Degenerate drops retract the solid closure claim through the existing hasher rule. |

The source/router operations inside each typed work item remain synchronous. Mapped item
execution, opening context construction/cuts, registered processors and their RTC
hooks still run through the current canonical builders. The session does not yet
expose each reached source, opening or numerical action as a transport command.

## Owned counters and thread-bound installation

`ifc_lite_geometry::kernel::budget::ElementState` is a public owned state with
`new`/`Default` and `with_scope`. The processing session is its concrete consumer.
It captures operation/element counters and cap snapshots at the existing element
boundary. Each synchronous advance installs this state, saves its progress on
return or unwind and restores the enclosing caller state. Normal `budget::begin`
still starts an operation and snapshots the operation cap as before; resuming a
slice does not itself reset the cumulative element budget or re-read its cap.
The state is `Send` and is not cloned, because cloning would fork consumed work.
Its installed guard is `!Send` and must finish on the executing thread.

The private degenerate-drop `ElementState` follows the same owned-state/short-lived
`!Send` guard pattern. `TriangleOrderScope` restores the previous router policy on
each constructor/advance return or unwind, including a registered processor panic.
On normal completion it also saves the actual product mode, including a custom
processor's interior mutation, for the next slice. No thread-bound accounting or
router-configuration guard is held between slices.

These mechanisms isolate counters and temporary configuration. They do not move
router caches, in-flight operations or processor diagnostic streams. Tests target
owned job/map/metadata/hasher transfer after synchronous planning and before any
numerical/router execution, plus independently owned routers interleaving slices.
Those targets must not be described as general router/cache migration. The historical
[product receipts](evidence/geometry-platform-products/validation.json) record
5,678 passed native invocations and 206 passed WASM contract cases (seven fixture
skips), plus six matching real-model geometry fingerprints. These checks do not
establish full presentation equivalence, router migration or latency non-regression.

Final processor failure hooks run inside the same validated lexical ownership
contract using a shared-decoder trusted scope. They can produce synchronous child
geometry with a fresh compatible decoder. Finalization preserves the restored
caller triangle-order mode and uses panic-safe pending-report delivery; it does
not reinstall the product's triangle-order policy.

## Diagnostic ordering is part of the contract

The session retains the original CSG drain boundaries. A discarded primary
attempt drains only at its existing retry point; the final chosen result drains
once at publication. There is no per-poll CSG drain. Type-map failures from
multiple processor streams can be grouped by the final drain differently from
poll order, so collecting fresh deltas at every advance would change observable
ordering. The final processor drain intentionally sees the restored caller's
triangle-order mode, as in the original whole-element producer; it does not
reinstall the product mode. Existing cache de-duplication and unattributed
buckets also remain relevant.

Pending curve/face and mapped-CSG TLS channels now have owned scoped state.
Ambient curve/face reports stay isolated; only the legacy pending mapped-CSG
channel is deliberately adopted at first live admission. Reached work and
assembly install this state, and finish republishes remaining product curve/face
reports for the existing upstream drains. Synchronous panic handling restores
ambient state, delivers owner pending reports through the active scope and
poisons the session.

Full router diagnostic channels and cache effects remain in the leased owner,
not an owned reply envelope. Sparse registry capture records actual selected
processor entries, with shared alias identities and distinct replacements;
custom advertisements do not imply built-in semantics. Direct constructors,
boolean factories and contextual paths outside instrumented registry calls are
not covered. Contextual work tags and this trace support reply validation, not
complete geometry provenance. Channel-specific diagnostic staging and original
ordering/rewind semantics remain requirements before diagnostics can leave the
router at finer boundaries.

## Coordinate, appearance and retained contracts to preserve

- Keep current raw source units, angle units, quality, `MeshFrame` restoration,
  local f64 origins and RTC hook dispatch. Do not join different origins as one
  f32 operand frame. Preserve `origin`, `rtc_applied`, placement/bounds, instance,
  welding and plane-tag sidechannels according to their existing validity rules.
- Keep `SubMesh.geometry_id` and the material-versus-representation-item
  discriminator. Preserve UV/texture attachments, indexed triangle ordering,
  palette splitting and fixed opening display colors through shared assemblers.
- Keep instance-only success, raw occurrence identity, template finalization,
  type-map suppression/tagging and product-versus-type hashing policy.
- Keep nominal authored quantities distinct from evaluated net volume. Published
  hashes, bounds and closure must describe the chosen output, including its final
  orientation and degenerate edits.
- Continue using the permanent exact/discrete engine under the current product
  policy. Retained construction requires explicit representation/evaluation and
  conversion contracts; a failure cannot silently select different mathematics.
- Extend existing authored definition/occurrence identities into completed product
  provenance. Raw-solid recipes and retained display admission cannot discharge
  unverified representation coverage or stand in for final cut geometry.

## Next implementation and acceptance

Extract finer mapped-source and opening-context work into typed, reached command
boundaries. Preserve conditional admission, current processor overrides and source
recovery rather than compiling unused branches eagerly. Commands must distinguish source
construction, exact operations, retained operations, explicit tessellation and
registered-processor execution. Keep borrowed decoder/router pointers and Rust
trait objects inside the owning Rust execution environment. Preserve conditional
opening classification, shared opening context, part frames, residual cutters,
engulf detection, rollback and cache-commit suppression for truncated walks.
The internal boundary already validates session/sequence/stage, owners and
configuration, payload and emitter evidence. Add model/load epoch, revision,
contract and frame acceptance before external reply-driven execution.
Cancellation and independent execution still require explicit lifecycle
behavior; no public product-session protocol is provided today. Cancellation must release
owned geometry leases, discard unpublished results, clear pending work and restore
configuration. External configuration/unit/quality changes while work waits
must invalidate pending work; trusted synchronous callbacks use same-owner work
commit. Product triangle-order mutations are carried between slices while the
caller's ambient mode is restored at each boundary. Every completed product must account for selected items,
reached enclosing operations and applicable openings before discharging
`RepresentationCoverageUnverified`.

Move diagnostics only after emitter-tagged transactions preserve existing drain
ordering. Qualify source/cache ownership before allowing executing sessions to
change routers or workers. Then connect retained construction/tessellation,
source coverage and final product completion through this boundary and migrate
all consumers together. Keep the canonical producer and shared presentation
policy throughout.

Required preservation cases include representation-less alignments; owned type
maps and tagging; malformed annotations; indexed palettes/material layers and
textures; mapped DAGs/cycles/truncation and distant part origins; rotated/scaled
RTC hooks; reference-only versus malformed openings; mapped templates with
different cuts; consumed/empty success versus retry; primary diagnostic rollback
and final grouping; instance-only/template recovery; hash/closure/volume semantics;
ambient counters and panic restoration. Qualify native-style and browser-batch
execution, real model geometry/appearance/frames, cross-target behavior and
end-to-end resource/performance impact. Later reply-driven work additionally needs
cancel/restart/stale-reply tests. Available tests are evidence targets, not a
completed no-loss verdict; do not weaken existing gates to complete this migration.

The [work/reply ownership contract](geometry-platform-work-boundary.md) maps the
actual router, processor, cache and TLS channels to the next coherent execution
boundary. Exclusive reservations and typed stage/reply checks are implemented
synchronously; complete diagnostic envelopes, template publication and external
lifecycle acceptance remain requirements before asynchronous execution.
