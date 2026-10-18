<!-- SPDX-License-Identifier: MPL-2.0 -->
# Implementation design: one geometry platform, complementary kernels

Status: whole-platform implementation in progress, 2026-10-18. Canonical phase
separation, owned constructor seams, conditional boolean/CSG continuations and
typed synchronous owned product orchestration with validated executor ownership
are implemented and have scoped qualification receipts. Complete product/consumer
migration and retained-engine activation
remain open. The [current implementation plan](../../docs/architecture/geometry-platform-next-steps.md)
and [foundation status](../../docs/architecture/geometry-platform-foundation.md)
identify implemented scope and separate validation receipts. The
[product-session contract](../../docs/architecture/geometry-platform-product-session.md)
records the implemented control layer and next ownership/work boundary. This incorporates the maintainer's requirement to lose no existing
capability, including the exact arithmetic kernel. It supersedes any earlier
proposal to delete that kernel or universally route solid operations to SMLib.

## 1. Recommendation and non-negotiable contracts

Build a Rust-owned geometry document and execution service. Preserve the current
exact polyhedral engine as a first-class engine. Add SMLib for retained curved
BRep construction, operations and interchange. Unify interpretation, identity,
placement, appearance, scheduling, diagnostics and consumers around them.

The major change is a complete architecture migration, not a collection of
special-case SMLib adapters. Two mathematical engines do not require two IFC
loaders, two style resolvers or two competing pipelines. Engine choice follows
an explicit evaluation contract, decided before execution and included in cache
keys. Failure never silently switches the mathematical meaning of an operation.

Preserve existing supported input families, public APIs, exact arithmetic,
determinism guarantees, browser/offline operation, headless operation, exports,
query behavior, textures, instancing, federation and load controls. Every claimed
preservation needs evidence. Existing defective output is not the oracle for a
correctness improvement; deviations need independent evidence and an explicit
behavior decision. No tests are weakened simply to accommodate the new kernel.

Maintainability is measured by removing duplicate orchestration and unnecessary
approximation/repair code, while retaining useful algorithms. A smaller line
count is not a reason to remove a capability.

Alternatives considered: an SMLib-only platform loses exact arithmetic; adding
SMLib separately to each IFC processor duplicates routing and lifecycle; pushing
all geometry through OpenUSD introduces a new browser dependency without solving
IFC interpretation or exact arithmetic. A shared document with two explicitly
bounded engines preserves the most capability, but adds genuine packaging and
testing cost. The maintenance win remains a hypothesis until duplicate policy
is removed and the upstream patch/upgrade burden is measured.

## 2. What the source inspection changes

| Evidence in this checkout | Implementation consequence |
| --- | --- |
| `rust/processing/src/element.rs` is the common native/browser element path and contains submesh/fallback decisions | Evolve this common path; migrate its policies once, including failure reporting and `TypeGeometryMode` |
| `rust/processing/src/analytic_export/definitions.rs` already has `AnalyticSourceKey`, reusable definitions and occurrences | Extend the existing source/occurrence concept; preserve current public raw-file-unit contracts with adapters |
| `rust/geometry/src/kernel/mod.rs` carries explicit/implicit points, exact signs and rational oracle tiers | Retain this mathematical foundation and its tests; do not reimplement it in C++ |
| `kernel/mesh_bridge.rs` snaps f32 inputs, reconciles operands and returns f32 mesh positions | Exact predicates do not imply that the whole current pipeline is lossless; separate the exact core from conversion policy |
| PDF/vector code, topology checks, welding and other modules consume kernel predicates | Deletion must follow a whole-repository dependency inventory, not directory labels |
| `rust/processing/src/geometry_pool.rs` uses Rayon; FFI/Python depend on it | Preserve exact work on Rust threads; isolate concurrent SMLib work in processes |
| `packages/geometry/src/geometry-worker-init.ts` configures workers, replacement workers and load toggles | Extend the existing worker lifecycle and configuration protocol, including restart behavior |
| `rust/export/src/usd.rs` exports local f32 meshes with double placements | Retain this interoperability and georeferencing contract; add geometry representations without changing world placement |
| `packages/ifcx/src/geometry-extractor.ts` handles composed mesh occurrences and appearance | Preserve composition semantics; introduce a geometry admission boundary rather than duplicate composition in a kernel |
| `packages/drawing-2d/src/section-cutter.ts` and `rust/clash/src/` consume meshes | Keep existing mesh behavior while adding representation-aware queries; a BRep API is not a complete replacement for drawing/clash policy |

Source locations refer to base `8acd0715a5ad266cd57808b9889f6549fbf93631`.
This is an inspected architectural map, not an exhaustive consumer inventory.
The implementation must produce that inventory before removing code.

## 3. Exactness, fidelity and representation are separate dimensions

The exact kernel evaluates signs over explicit binary input coordinates and
symbolic line-plane/three-plane intersections. This avoids rounding implicit
intersections before classification. Its interval/fixed tiers have rational
oracles. Preserve those contracts and cross-platform tests.

That does not make a polygonal approximation equal to the original curved
surface. Current snap, weld, f32 conversion and output reconstruction also matter.
Do not market every existing mesh result as mathematically exact end to end.

SMLib preserves analytic/NURBS surface descriptions, but operations use tolerances
and measurement uses numerical integration. A manifold BRep does not imply a
closed tessellation, a successful API call does not imply correct geometry, and
an exact predicate on its tessellation does not certify the source BRep.

Each evaluated representation needs separate facts: source lineage, representation
kind, evaluation policy, coordinate frame, revision, normalization policy,
requested tolerances, validation results and known approximation steps. Requested
chord error is not a certified global error bound. Record a bound as verified
only when a suitable checker establishes it.

## 4. Geometry document: the durable source of truth

Use one document per loaded model with a session identity and revision. Source
entity IDs remain model-local; federation resolves occurrences through the
existing registry/store contracts. Persistent keys may include the source digest,
schema and representation context; edits add stable document-local identities
and revisions instead of rehashing an entire model on every change.

Keep three related layers:

1. **Authored descriptions:** IFC profile parameters, curves, surfaces, topology,
   operation DAGs and source bindings. Preserve original units/values for current
   analytic APIs and roundtrips. IFCX mesh/BRep attributes enter through their
   format adapter after composition.
2. **Evaluated representations:** exact-polyhedral results, SMLib BReps, explicit
   meshes and curves. A result identifies its evaluation contract. An element can
   carry multiple named representations, but a consumer request selects one;
   they are never assumed geometrically identical merely because they share an ID.
3. **Derived products:** display/export meshes, bounds, sections, mass properties,
   picking maps and spatial indices. Each is tied to an evaluated revision and
   query/tessellation options.

Definitions are reusable and occurrences supply f64 transforms and presentation.
Host-specific openings produce derived definitions keyed by base definition,
ordered operation dependencies and relative cutter placements. Two instances of
one mapped wall with different openings must not share the same cut result.

The operation DAG is iterative and budgeted. Preserve path multiplicity for
accumulating IFC walks; memoize pure definitions. Validate lengths, topology
indices, knots, weights, finite coordinates and transform invertibility before
FFI. Distinguish legal open shells from solids that failed validation.

Suggested internal request concepts, not new public API commitments:
`GeometryRequest(document, revision, occurrence, purpose, evaluation_policy)` and
`GeometryResult(representation, provenance, validation, diagnostics)`.
Use Rust types as authority and generate wire declarations; never maintain a
second handwritten TypeScript schema for the same protocol.

## 5. Evaluation policy: preserve guarantees before choosing an engine

| Request / input | Recommended execution | Required result semantics |
| --- | --- | --- |
| Existing exact-polyhedral operation or caller requiring its guarantees | Existing Rust exact engine | Preserve normalization, budget, diagnostic and determinism contracts |
| New retained curved-BRep operation | SMLib | Tolerance-based BRep with validation and explicit failure |
| Explicit mesh display/export | Mesh representation directly | Preserve supplied topology, indexed colors, UVs and appearance |
| Closed mesh requiring exact CSG | Rust exact engine | No forced BRep reconstruction |
| BRep requested as an exact-polyhedral operand | Explicit tessellation then exact engine | Exact decisions over the normalized discrete operands; curved-source approximation disclosed |
| Mesh combined with retained curved BRep | Resolve the requested contract first | For polyhedral semantics, tessellate the BRep; for BRep semantics, admit a validated faceted BRep or refuse the conversion |
| Open/non-manifold geometry | Preserve its supported surface/mesh operations | Do not silently close it or invent solid volume |
| PDF/vector/drafting predicates | Existing exact predicates where used | Preserve the existing predicate contracts |

For compatibility, existing APIs retain their current evaluation policy until a
replacement is shown to preserve their documented behavior. Add capability-aware
requests for retained BRep operations; do not route based on whether a preceding
kernel happened to fail. An operation explicitly requesting exact-polyhedral
semantics must never receive a tolerant BRep substitute.

A single product with both representations needs a deliberate display/query
selection policy. Measurements and exports identify the selected geometry
revision and representation, avoiding queries against an uncut source while
showing the cut result. Current nominal authored quantities remain nominal;
net evaluated volume is a different quantity, not a replacement value.

This preserves the exact engine permanently as a supported responsibility.
Temporary old orchestrators may disappear after migration; the useful engine is
not a temporary fallback. A whole-platform cutover can preserve current defaults
while adding the retained-BRep capabilities coherently.

## 6. IFC lowering and SMLib capability mapping

Build a small typed operation vocabulary from IFC descriptions. Lower exact
EXPRESS semantics in Rust; keep numerical implementation behind the engines.
High-level SM_API has C++ types and overloaded functions, so it is not the ABI.

| IFC operation family | Upstream candidate inspected | Work required before coverage is claimed |
| --- | --- | --- |
| Lines, circles, ellipses, B-splines | `SmApiCurves.h` constructors | Parameter domains, orientation, knot multiplicity, weights and units |
| Extrusion/revolution and tapered profiles | `SmApiCreateLinearSweep`, `SmApiCreateRotationalSweep`, `SmApiCreateTaperExtrude` | Hollow profiles, holes, profile frames, winding and taper correspondence |
| Swept disks and swept profiles | Pipe/curve sweep APIs in `SmApiBrep.h` | Frame transport, discontinuities, inner radius, start/end parameters and IFC reference-surface semantics |
| Advanced surfaces and trimmed faces | `SmApiCreateSurface`, `SmApiTrimSurfaceWith3dCurves`, lower-level topology construction | UV/3D trim consistency, same-sense flags, periodic seams, poles and ownership failure behavior |
| Faceted BReps / tessellated sets | Planar face construction, stitching or lower-level topology APIs | Shared edges, cavities, manifold classification, open-shell handling and attribute preservation |
| Boolean union/difference/intersection | `SmApiBoolean*` | Copy/consume ownership, order, disconnected output, empty success and provenance |
| Half-space / bounded half-space clipping | Plane cuts / constructed finite cutters, subject to proof | Agreement flags, polygon bounds and provably sufficient extents; never an arbitrary huge box |
| Sectioned solids, alignments, infrastructure | Existing IFC semantic evaluation plus possible skin/sweep construction | Not demonstrated by a generic sweep symbol; preserve current coverage until all mappings qualify |
| Sections and closest points | `SmApiIntersectBrepWithPlane`, query APIs | Loop assembly, tangencies, coincident faces, ordering and output attribution |
| Area/volume/mass | `SmApiBrepComputeMassProperties` and related queries | Accuracy controls and independent analytic/model validation; defaults are not sufficient evidence |
| Tessellation | `SmApiTessellate` | Strict output, seams, winding, face mapping, quality control and mesh validation |

Lower IFC into shared Rust descriptions before numerical evaluation.
The pinned NVIDIA source is Apache-2.0; keep upstream ownership and licensing
separate from IFC interpretation and application semantics.
No GPU acceleration or full IFC coverage follows from NVIDIA authorship.

## 7. C ABI and transactional ownership

Own a small `extern "C"` shim over pinned SMLib + SM_API. Expose fixed-width
scalars, versioned buffer descriptors and generation-checked handles. No STL,
C++ references, `long`, exceptions or allocator ownership crosses the boundary.
Check conversions to upstream ULONG/long and wasm32 sizes explicitly.

Start with session initialization, execute-batch, read-result, release-result and
release-body operations. Commands carry typed arrays with validated lengths;
results carry status plus owned buffers and diagnostics. Separate operation status
from topology/quality results. Empty geometric result is distinct from failure.

Make application definitions immutable. Copy cached BReps before destructive
operations. SMLib boolean success mutates the first operand and generally consumes
the second; failure can modify both. Publish the new revision only after validation;
discard transaction-owned operands on failure where ownership is well defined.
Never mutate a shared mapped definition in place.

`SmApiTrimSurfaceWith3dCurves` explicitly documents indeterminate ownership on
failure, including an unfreed partial BRep. Ordinary RAII cannot fix an unknown
ownership graph. Initially mark that worker unhealthy, terminate/recreate it and
replay durable descriptions. Prefer an audited lower-level construction path or
a minimal tested upstream patch for normal production use. Measure repeated-failure
recovery, not just successful disposal. Never retry a poison input indefinitely.

Catch C++ exceptions inside the shim. Process/module death remains a separate
failure channel: catch-unwind cannot catch memory faults or stack exhaustion.
Handles include worker epoch and generation so stale results cannot reference
objects allocated after restart. Borrowed face/surface pointers stay inside a
single shim operation and are reacquired after representation-changing transforms.

## 8. Runtime and packaging decisions

### Browser

Use one worker with independent Rust and Emscripten instances for the initial
integration design. The existing Rust module compiles descriptions and handles
exact operations; the SMLib module evaluates BRep batches. JavaScript only bridges
buffers and worker messages. The current feasibility probe already validates
independent Emscripten worker instances without shared memory.

Keep the two heaps explicit. A Rust-memory view cannot be transferred as if it
were an owned result buffer; WASM memory growth can invalidate views. Batch input
copies into the SMLib heap, extract results once into owned buffers and release
native results deterministically. Transfer owned buffers to the rendering thread.
Retain bodies in their worker for later sections/queries instead of serializing
BReps after every operation. Compile modules once where supported and instantiate
independent memories; module sharing is not memory sharing.

The currently synchronous Rust element call needs a real boundary change: split
planning, execution and assembly into an explicit state machine, driven by the
same processing logic on both targets. A browser plan can yield command batches
and resume with results; native drives that protocol with blocking/async transport.
Do not attempt to call asynchronous JavaScript IPC from an unchanged synchronous
Rust function. Avoid Asyncify unless measured evidence requires it.

Preserve initial streaming, early progress, worker restart configuration and
abandoned-generator cleanup. Synchronous C++ blocks the worker event loop;
cooperative cancel only acts between commands unless upstream supplies a proven
interrupt mechanism. A supervisor can terminate a timed-out worker and replay
unaffected definitions. Tag all messages with load/revision epochs.

Publish the Emscripten glue/WASM as a version-pinned declared dependency of the
consuming package, with explicit asset URLs. Test installed npm tarballs in Vite,
webpack and Node paths supported today, CSP/module-worker loading, offline caching
and mismatched/stale assets. Lazy initialization may avoid BRep startup for mesh-only
loads without changing the available geometry semantics.

### Native, Python and embedded FFI

Keep exact work in Rust threads. Use a bounded pool of long-lived SMLib subprocesses,
each creating one default context and processing calls serially. The inspected
upstream contract explicitly rejects arbitrary concurrent SM_API calls in one
process. Do not put SMLib pointers in Rayon closures or assume a mutex around only
construction makes subsequent calls safe.

Start with length-prefixed versioned binary IPC over pipes; benchmark before
introducing shared memory. Co-locate dependencies and cached definitions by stable
affinity; use controlled duplication/replay rather than moving raw handles between
workers. Whole-model parsing must not repeat in every SMLib subprocess.

Ship a discoverable worker executable for every supported native package/platform,
including Python wheels and C ABI consumers. Embedders must receive an explicit
worker location/configuration contract; silently requiring a system-installed
binary would lose deployment capability. Test concurrent Python/FFI callers,
process shutdown, fork/spawn behavior and disconnected clients. Platforms that
cannot launch workers need a proven alternative before claiming preservation.
A native WASM-hosted SMLib instance is an alternative isolation experiment, not
an assumed solution or an extra mandatory production backend.

Single-artifact Rust/C++ WASM linking might reduce copies later, but changing the
Rust target/runtime and reconciling exceptions/libc is unproven. Keep it off the
critical path until the dual-module integration is measured. C++ builds/toolchains
become a supported centralized build concern, replacing the current pure-Rust
architecture rule deliberately, not through scattered scripts.

## 9. Coordinates, tolerances and determinism

Preserve source units separately from evaluation units. Normalize evaluation to
metres in object-local f64 coordinates, with f64 transforms and explicit frame
metadata. Compute cutter-to-host transforms in f64. Apply the canonical MeshFrame
world restoration once; convert Z-up to Y-up only at the existing viewer boundary.

Separate model precision, exact-engine reconciliation, BRep tolerance, tessellation
chord/angle controls, query accuracy and display LOD. Do not infer all of them from
one epsilon or silently apply a model-wide bounding-box scale. Current snap-grid
unit behavior in `mesh_bridge.rs` must be preserved or corrected with independent
regression evidence; a refactor must not accidentally change it.

Never round through the display f32 mesh to feed a new modeling operation when
source f64 geometry is available. Introduce an f64 exact-engine admission path
as a separately tested improvement; it cannot be claimed byte-identical to the
current f32/snap bridge. Preserve the existing route where its compatibility
contract is requested.

Keep exact predicate and current deterministic output gates. For new BRep paths,
measure x86_64, arm64 and wasm results and distinguish semantic agreement from byte
identity. Stable IDs/order require explicit ordering, but sorting does not fix
geometric nondeterminism. Any relaxation of an existing guarantee is a failed
no-loss gate, not an automatic baseline update.

## 10. Provenance, presentation, edits and cache lifetime

Use revision-local face IDs plus source lineage sets, not C++ addresses or face
array positions. `SmPolyFaceData::m_lFaceIndex` can associate tessellation faces
with a BRep face in that result; it is not proof of identity across booleans.
Test attribute/history propagation through split, merge, copy and trim operations.
The implementation must not invent a reliable topology-history API if upstream
cannot provide one. Keep complete source-operation ancestry; report face lineage
as unresolved when necessary rather than misattribute it.

Preserve existing Rust style resolution, cut-face policy, indexed colors, UVs,
textures, shading color and appearance groups. New faces need an explicit mapping
or the same documented material rule as today's output. Source UVs and generated
parameterization are different contracts. Provenance/material loss blocks cutover.

Cache keys include definition revision, operation dependencies, evaluation policy,
normalization/tolerance policy, kernel build identity and tessellation options.
Appearance-only edits invalidate appearance buffers, not solid construction;
placement-only changes reuse local geometry unless relative opening geometry or
other dependencies change. Async stale results are rejected atomically by revision.

Retain compact descriptions and a bounded working set of bodies/meshes. Worker
memory high-water marks may require recycling even after C++ frees objects.
Track both allocated live objects and resident/linear-memory growth. Undo restores
source revisions, recreating evicted evaluated bodies on demand. Unload cancels
requests, releases leases and invalidates handles even when loading was interrupted.

## 11. USD/IFCX and downstream consumers

Continue interoperable UsdGeomMesh output with the current hierarchy, metadata,
instancing and placements. Add versioned BRep representation alongside it, with an
explicit relationship/selection rule preventing duplicate visible geometry. A
mesh-only consumer must render the object once. Both payloads identify the same
revision; a stale mesh must not masquerade as a preview of an edited BRep.

Use NVIDIA BrepArray as the candidate interchange schema, independently of opaque
SMLib `.smb` snapshots. The inspected public `.smb` APIs are file-based; in-memory
serialization and version compatibility still need verification. Internal native
snapshots, if used, are version-scoped caches, never the only durable model form.

Full OpenUSD was not part of the browser proof. Investigate extracting the existing
BREP data codec from USD-specific stage code so browser serialization can share
schema-derived structures. A second handwritten trim/topology codec would add the
maintenance burden we are trying to remove. If that extraction is infeasible,
BRep browser roundtrip remains an unresolved delivery requirement, not a feature
quietly assigned only to the server.

Define/version an IFCX geometry extension explicitly; preserve layer composition,
provenance and unknown-attribute handling. NVIDIA's schema is not automatically an
IFCX standard. Current mesh-only IFCX files remain first-class, including edits.
Keep IFC semantics outside USD kernel data; importing BRep does not invent IFC
relationships or parametric authoring history.

Migrate consumers through compatibility facades: viewer/SDK/CLI/server/Python/FFI,
mesh exports, analytic-source APIs, quantities, sections and clash. GPU clipping
remains a display optimization; authoritative section curves can come from the
selected evaluated representation. Clearance distances, touching/intersection
classification and open meshes retain their existing meanings. Kernel intersections
alone do not implement clash rules, drawing visibility, line merging or annotations.

## 12. Delivery sequence and no-loss evidence

Proposed code ownership (names are internal design choices, not published APIs):

| Home | Responsibility |
| --- | --- |
| `rust/geometry` | Existing exact engine, predicates, reusable geometry descriptions and representation-independent types; preserve its dependency direction |
| New `rust/geometry-runtime` | Versioned command/result protocol, session/handle lifecycle and engine execution adapters; depend on geometry types, never on IFC processing |
| New `native/smlib-adapter` | Minimal C ABI, pinned CMake build and owned SMLib integration; no IFC parsing or appearance policy |
| New native worker binary using `geometry-runtime` | Process entry, serial SMLib dispatch and framed IPC; package alongside native consumers |
| `rust/processing` | IFC lowering, document revisions, dependency planning, canonical element assembly, styles, frames and diagnostics |
| `rust/wasm-bindings` | Plan/resume and result bindings for the shared service, with generated committed types |
| `packages/geometry` | Worker/asset setup, transport, transfer buffers and existing public compatibility facade |
| `rust/export`, `packages/ifcx` | Format projection/admission and composition integration; shared representation contracts |

Keep the protocol and lifecycle in one Rust crate initially rather than creating
a package for every conceptual box. Avoid a dependency cycle: neither geometry
nor runtime imports processing. A browser runtime adapter emits/resumes commands;
native connects the same execution contract to IPC. Keep implementation-only
exports private until an actual consumer requires them.

Deliver one architecture with a stacked integration branch. Each stage has a
reviewable outcome; no isolated IFC family is shipped with a separate pipeline.

1. **Capability ledger and contracts.** Enumerate producers, consumers, input
   families, API/deployment contracts and existing regression fixtures. Record
   exactness/determinism and malformed-input behavior separately. Every row names
   its target owner, preservation proof and any open question. Freeze operation,
   representation and diagnostic contracts before mass porting.
2. **Shared document and exact-engine integration.** Drive existing behavior through
   the new document/service using the current engine. Prove compatibility before
   adding SMLib-derived output. This isolates architectural bugs from kernel changes.
3. **SMLib boundary and platform integration.** Build native/process and browser/dual-
   module transports, ownership checks, transactions, restarts and packaging. Test
   poison inputs and lifecycle failures before persistent caches depend on them.
4. **Complete geometry lowering and retained representations.** Cover the inventory,
   including mappings, holes, half-spaces, periodic trims, infrastructure and mixed
   representations. Preserve exact operations and current behavior policies.
5. **All consumers and interchange.** Wire edits, provenance, queries, USD/IFCX and
   current APIs to the service. Prove representation coherence across all consumers.
6. **Qualification and coherent cutover.** Run separate base and replacement builds
   on the corpus and real viewer scenarios. Delete only superseded orchestration,
   dead conversion and proven redundant repairs. Retain the exact engine and any
   numerical routines still needed for a supported contract.

Required evidence includes:

- Existing regression corpus, real authoring-tool models, every entity outcome,
  geometry-family coverage and missing/extra-element detection. Include all load
  toggles and model counts 1 and N, overlay-created entities and type geometry.
- Exact predicates against rational oracles, implicit-point degeneracies, coplanar
  faces, slivers, cavities, deep boolean trees, repeated DAG operands and budgets.
- Independent topology/winding and bidirectional surface-distance checks, analytic
  volume cases, curved thin features and small missing cuts. Bounds/volume alone
  cannot detect missing operands; independent reference results need explicit
  admission criteria and remain fallible.
- Direct IFC-to-SMLib construction through IFC-Lite's source plans. Primitive
  probes do not establish interpretation or evaluation of the original IFC tree.
- Cold/warm/repeated loads, first visible geometry, total load time, peak memory,
  worker restart/cancel, exports and interactive query latency. Interleaved base/
  branch whole-worker-pool runs on the prescribed small, CSG and heavy fixtures;
  no kernel microbenchmark substitutes for those results.
- Native x86_64/arm64, wasm and supported browser/package environments; Python wheel
  and C ABI installation, real WASM boundary, Rust tests/Clippy, root turbo tests/
  typecheck, determinism/parity and external packed-consumer tests. Read current
  workflows and repository rulesets for the actual required gates at implementation.
- Retained evidence for material/texture/placement fidelity, source and evaluated
  quantities, layered IFCX edits, USD validation and same-revision roundtrips.

Counts, bytes and speed need separate verdicts. No deletion is justified solely by
another library exposing a similarly named API. No-loss cannot be proven for every
possible IFC file; make the supported contract explicit and require no unexplained
regression across its evidence. Unresolved losses block cutover.

## 13. Highest-priority experiments and decision records

| Experiment | Decision it resolves |
| --- | --- |
| Existing exact result through new document, same fixtures/pins | Whether the architecture preserves behavior independently of SMLib |
| Full worker transaction: Rust plan → C++ construction → face-aware mesh → Rust assembly | Boundary copy cost, ownership, provenance and actual browser packaging |
| Direct periodic/trimmed IFC cases, failure injection and worker recycling | Whether known seam and ownership defects require a bounded patch or another construction API |
| Same mapped definition with different host openings/materials | Whether cache keys and provenance are sufficient |
| Exact mesh + curved BRep operation under both explicit contracts | Whether mixed representations preserve guarantees without hidden approximation |
| Native worker installed through wheel and embedded FFI distribution | Whether isolation preserves existing deployment capability |
| BRep data export/import in browser without OpenUSD | Whether USD/IFCX retained geometry is feasible on every required target |
| Full-pipeline A/B on small and heavy models with repeated loads | Whether memory, startup and IPC costs are acceptable alongside fidelity gains |

Track downstream SMLib patches, upgrade effort, duplicate semantics removed and
retained engine responsibilities. Upstream's current contribution policy does not
accept external code contributions; a private repair fork can erase the maintenance
benefit. Pin dependencies and build configurations, test upgrades against this same
corpus, and keep cache invalidation tied to kernel identity.

Do not estimate a credible delivery date from ten smoke cases. Estimate remaining
work after the capability ledger and the boundary/ownership/interchange experiments;
those determine whether this is mostly an adapter effort or substantial upstream
repair and packaging work.

## Sources and evidence

- [Local reproducible evaluation and limits](README.md), [recorded evidence](evidence/).
- NVIDIA source pinned to `c9c5979f04cea8c38213004d4f04df0dcfb40d05`:
  [concurrency](https://github.com/NVIDIA-Omniverse/usd-brep/blob/c9c5979f04cea8c38213004d4f04df0dcfb40d05/.agents/operations/concurrency.md),
  [boolean and tessellation API](https://github.com/NVIDIA-Omniverse/usd-brep/blob/c9c5979f04cea8c38213004d4f04df0dcfb40d05/source/SM_API/inc/SmApiBrep.h),
  [trimming ownership](https://github.com/NVIDIA-Omniverse/usd-brep/blob/c9c5979f04cea8c38213004d4f04df0dcfb40d05/source/SM_API/inc/SmApiTrimmedSurfaces.h),
  [queries and accuracy](https://github.com/NVIDIA-Omniverse/usd-brep/blob/c9c5979f04cea8c38213004d4f04df0dcfb40d05/source/SM_API/inc/SmApiQueries.h),
  [known issues](https://github.com/NVIDIA-Omniverse/usd-brep/blob/c9c5979f04cea8c38213004d4f04df0dcfb40d05/KNOWN_ISSUES.md).
