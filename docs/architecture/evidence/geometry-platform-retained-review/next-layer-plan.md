# Retained SMLib integration after the common program

Read-only inspection of parent commit e2e42bbfb8bd087a386450a0ab643bcb061c133c.
No network access, secret reads, builds, tests, edits or new workers. Companion
inspection hashes are `/tmp/ifclite-retained-integration-inspection.json`.
This distinguishes actual implementation, locally available upstream source,
historical runtime evidence and proposed integration work.

## What is actually implemented

| Boundary | Existing code and actual meaning | Remaining connection |
| --- | --- | --- |
| Native C ABI | `native/smlib-adapter/include/ifclite_smlib.h`, `src/adapter.cpp`: real SDK box/cylinder, copied-operand boolean, volume, manifold, release and per-session slot/generation ownership. All sessions share one upstream context and must serialize. | No general extrusion/profile/directrix/BRep import or transform command, no source recipe/document connection. |
| Tessellation | `src/mesh.cpp`: real strict SDK tessellation, upstream polygon triangulation including holes, f64 positions, flat per-corner normals, triangle source-face indices and topology checks. | No analytic normals, persistent authoring-face IDs, IFC material/UV attribution or certified global chord error. |
| Protocol | `src/protocol.cpp`, `rust/geometry-runtime/src/protocol.rs`: one version1 command decoder, bounded request/response bodies, explicit byte order and u64 handles. | Commands expose only the primitives/operations above; variable-size authored input has no upload/commit protocol. |
| Native Rust | `worker.rs`, `worker_mesh.rs`: actual subprocess client, worker-affine opaque handles, strict transfer checks. `supervision.rs`/controller/process_control add bounded queue, queued deadlines, active cancellation, kill/reap and new-session invalidation. | No retained ProductProgram executor, durable recipe replay, multi-process ownership pool or OS memory enforcement. |
| Browser | `native/smlib-adapter/browser/{client,worker,module}.mjs`: actual independent module-worker instances, buffer ownership, pending admission, deadline/poison/restart and incarnation checking. | No Rust/WASM host binding, app asset packaging/integrity/lifecycle integration or canonical loader consumer. |
| GeometryDocument | `rust/geometry/src/document/`: owns object-local Mesh definitions, generation/revision handles and occurrence matrices; existing exact mesh bridge executes document booleans. RetainedBrep contract is explicitly refused by that executor. | It does not store authored retained solids, own runtime BRep results or run SMLib. A retained enum value is not an implemented evaluator. |
| Retained processing adapter | `rust/processing/src/retained_geometry.rs`: retains ProcessingResult and copies admitted mesh execution buffers into mesh definitions while preserving consumer output. | Explicit mesh retention, not recovered analytic construction or curved BRep authoring. |
| Authored inventory | `processing/src/authored_geometry/`: original extrusion/swept-disk definitions and placements; AuthoredSourceOnly recipes and explicit coverage/boolean/opening requirements. | Does not certify complete product lowering, evaluate net products or call SMLib. Unverified requirements cannot become empty success. |
| Production owned constructors | Existing extrusion/swept-disk and other production plans evaluate through the exact/default mesh builders. Some profiles/directrices are already sampled and explicit face-set coordinates may already have narrowed. | Reusing a sampled contour does not restore its authored analytic curve. These plans remain valid explicit geometry inputs, not automatically retained-analytic sources. |

`tests/smlib_worker.rs`, C++ adapter/mesh tests and browser contract genuinely
exercise the compiled SDK, not a mock geometry return value. Their inputs are
bounded synthetic primitives/booleans with analytic volume and independently
computed triangle/topology assertions. They do not prove real IFC authoring
coverage. Supervision partial-frame peer and hung/missing-asset worker fixtures
are transport fault injection, not evidence of kernel geometry or a naturally
hanging modeling operation. Without IFCLITE_SMLIB_WORKER, Rust real-worker tests
skip explicitly; historical green general Cargo output alone is not proof that
those tests ran. Foundation/evaluation receipts identify separate prior native,
WASM/Node and browser runs; no fresh execution was performed in this review.

## Local upstream source and license evidence

The full upstream source checkout exists locally at
`/tmp/ifclite-smlib-eval-upstream`, HEAD
c9c5979f04cea8c38213004d4f04df0dcfb40d05, matching `upstream.json` and adapter
CMake pin. Its SMLib/SM_API sources are present; it is not merely a missing
proprietary binary SDK. Observed untracked files are build/tool cache directories;
no tracked source modification was reported by this inspection. The adapter
CMake checks the pinned revision and SMLib/SM_API cleanliness, compiles those
minimal sources and does not link the USD/Python/TBB integration components.

A root LICENSE and THIRD_PARTY_NOTICES.md are available; inspected headers and
sources carry Apache-2.0 identifiers. Thus "no license evidence available" would
be inaccurate. This is file/provenance evidence, not a completed redistribution
or all-dependency compatibility assessment. A shipped artifact still needs an
exact compiled-input/license/notice inventory and packaging receipt, including
actual dependencies enabled for a future USD path. The checkout is outside the
repository; no vendor snapshot, reproducible dependency acquisition/publishing
receipt or deployment package follows just from its presence. Do not silently
build against a moving checkout or require a separately imagined SDK license.

Upstream KNOWN_ISSUES.md is also present. It documents modeling/healing and
trimmed-surface measurement/tessellation/import limitations. A success status
must not substitute for independent geometry/topology validation, and the
current minimal adapter is not a qualification of the larger USD import stack.

## Source-backed feature opportunities and exact missing payloads

### Authored extrusion

SM_API/inc/SmApiCurves.h exposes line/arc/circle creation and canonical B-spline
creation from control points, knots, multiplicities, optional weights, degree
and form. SmApiBrep.h/.cpp implement SmApiCreateLinearSweep over borrowed input
curves, direction, distance and cap flag; the implementation copies curves before
the consuming builder and returns a newly owned BRep. SmApiCreateExtrude in
SmApiSurfaces.h creates a surface; do not confuse it with a capped solid sweep.
Rotational sweep/curve sweep/taper operations also exist locally, but their
availability is not IFC semantic coverage.

Add a typed authored region/curve payload retaining ordered outer/inner loops,
curve orientation/trims, separate profile Position and solid Position, sweep
direction/depth and source IDs/status. Line/arc regions can use existing analytic
profile definitions; unsupported source families stay explicit. General rational
curves need actual authored coefficients and parameter ranges, not a fitted curve
through production sample points. Validate finite values, extent collapse,
counts, knot/multiplicity relations and loop closure before invoking upstream.
Construct temporary SDK curves with RAII cleanup and publish the solid handle
only after the entire operation and its qualification checks succeed. Qualify
holes/nested regions and multiple regions explicitly; a flat list's API presence
does not prove that it reproduces every IFC loop grouping rule.

### Swept disks

SmApiCreatePipeSweep accepts radius, a SmBSplineCurve path and cap flag.
SmApiCreateCurveSweep accepts profile curves and a B-spline path with sweep options;
SmApiCreateSweepAlongPlanarPath accepts ordered connected path/profile curves and
has documented cap/nesting/miter behavior. These are real upstream producers,
not exposed by our ABI/protocol. They are alternative SDK operations whose exact
semantics need qualification against admitted IFC source contracts.

The host payload needs original directrix segments/ranges, radius, InnerRadius,
cap/closed-path semantics, transforms and source status. Existing authored
SweptDiskDefinition preserves original analytic segments; production SweptDiskPlan
contains sampled points and is not that source. Do not interpolate samples into
a smooth path and call it exact authored geometry. InnerRadius is not an argument
of PipeSweep; a hollow profile via qualified curve sweep or an explicit owned
outer-minus-inner operation needs its own validated policy. Composite/nonplanar
paths, discontinuities, self-intersections, end parameters and hollow caps must
be admitted or explicitly refused. Planar-path miter behavior cannot be assumed
to match all current tube join conventions.

### Boolean/CSG and mixed representation inputs

The current adapter already calls real SmApiBoolean and copies both operands,
including identical-handle operands, before a destructive SDK call. It provides
tolerance-based BRep operations, not exact predicates. Connect it only to an
explicit RetainedBrep evaluator contract on a reached common-program operation.
Preserve ordered boolean dependencies, empty/recovery semantics and distinction
between source construction and final product, including external openings.
Do not route an ExactPolyhedral failure to SMLib, or turn a retained failure into
an exact execution and report the original contract succeeded.

Every retained dependency must be available in the same worker incarnation.
A bare numeric handle or a handle from another process cannot be used. Rehydrate
owned admitted recipes into a selected worker or refuse unavailable dependencies;
mesh conversion is a separate explicit operation with approximation/provenance.
The host must define unsupported mixed mesh/BRep operations before invoking a
kernel. Mesh-only input remains a first-class permanent representation and must
not be relabeled authored curved geometry.

### Occurrences and source frames

Upstream SmApiTransform/Scale/Translate support modeling objects; header contracts
distinguish rigid reuse from representation-changing scale and owned-surface
pointer invalidation. No corresponding adapter command exists. There is no need
to make kernel handles into scene instances: document definitions plus host-owned
f64 occurrence matrices can reuse one local BRep/tessellation for rendering.
Boolean operands in different placements require an explicitly transformed copy
in a common local evaluation frame, never mutation of a cached source definition.
Nonuniform/mirrored transforms, normals, winding and volume scaling need dedicated
qualification; rigid-transform reuse cannot be generalized to them silently.

Keep authored raw IFC file units and source angle conventions in source data.
Keep profile Position, solid Position, mapping and product placement in their
original order. Choose and record a small object-local evaluation frame in metres
for worker commands; scale once at the evaluator edge and preserve the inverse
frame for output publication. Existing analytic occurrence matrices are column-major
source-to-world f64 including unit scale; GeometryDocument uses row-major local-to-model.
Make this conversion explicit. Current primitive origin conventions and positive-Z
cylinder must not accidentally become general IFC placement conventions.
Large-world origin collapse must be refused or handled by planned f64 rebasing,
not repaired after f32 narrowing. Never infer model coordinates by adding RTC in f32.

### Appearance and USD/IFCX

Current ABI has no appearance, UV, source material or persistent topology mapping.
The source-face stream is revision-local GetFaces indices, not IFC IDs or stable
edit provenance. Upstream USD integration source exists separately in SM_API_USD,
BREP_USD_DATA and schema/omniSolid; it includes material binding/tessellation data,
but our minimal build does not compile or qualify those components. A kernel's
material-region census is not an IFC appearance resolver.

Keep IFC style/material/layer/texture decisions in the existing canonical Rust
appearance/assembly layer. A retained evaluation needs an explicit map from
source surface/feature to resulting revision-local faces, including newly cut
faces; qualify that mapping before assigning inherited materials or UVs. Until
then expose provenance unavailable rather than fabricate persistent face IDs.
Current flat tessellation normals cannot silently replace a consumer's required
smooth analytic shading. Existing indexed texture meshes and their UV seams
remain explicit meshes when no authored parameterization mapping exists.

Existing mesh USD export and IFCX importer/composition stay public and operational.
The separate stored IFCX/USD receipts cover their actual consumer paths, not a
native IFCX parser or retained BRep USD export. Connect any new authored IR at the
existing canonical format-adapter boundary; do not introduce a new viewer/federated
load pipeline. Native Rust STEP admission and browser IFCX composition are distinct
current capabilities. A future retained USD schema export must be explicitly
requested and qualified with a real stage reader; it cannot replace the existing
mesh export contract or claim fidelity by preserving only a filename/prim count.

## Concrete common-program integration

1. Introduce a representation-bearing definition alongside existing mesh
   definitions: ExplicitMesh, AuthoredSolid/ordered operations, and explicit
   unsupported requirements. Preserve add_mesh_definition and exact boolean APIs.
   MeshDocument requests currently snapshot mesh handles; new EvaluatedBrep and
   retained requests must be distinct typed results, not hidden Mesh fields.
2. The host selects EvaluationContract before source admission/evaluation and
   records supported construction features, policy/tolerances, units/frame and
   actual selected processor emitter. The exact engine remains the default and
   permanent implementation for existing polyhedral consumers, including users
   of exact predicates outside solid booleans. Do not add a hidden runtime kernel
   selector to the ordinary CSG path.
3. Extend the common program's admitted source payloads with genuine authored
   curve/profile/directrix data where available. Keep production sampled constructor
   variants separately named. Source coverage and operation completeness are
   tracked per product/occurrence, not inferred from one supported extrusion.
4. Ready retained operations contain only owned source data or validated runtime
   handles and explicit transform/tolerance policy. The evaluator resolves logical
   definition/revision to worker-affine handles. Completion carries document/model
   revision, source epoch, command/occurrence, emitter, input handle generations and
   worker incarnation. Reject stale/foreign packets intact before publication.
5. Add C ABI and single C++ protocol decoder support for curves/regions/extrusion,
   swept disks and copied transforms. Extend Rust protocol, native worker/supervisor
   and browser transport together. Variable payloads exceed current4096-byte
   requests: use bounded staged upload/chunk/commit with declared counts/lengths,
   overflow checks, transactional incomplete-object cleanup and explicit new
   capability/version negotiation. Do not just raise the bound or duplicate IFC
   interpretation in C++/JS. Keep version1 behavior for existing clients.
6. Worker loss invalidates only runtime realizations. The document owns replayable
   admitted recipes and explicit dependency order; lost handles do not become
   durable geometry references. Replay/retry is a separately controlled request,
   not an automatic backend switch or publication of a late old completion.
7. Tessellated retained results pass through the same geometry frame/style/metadata/
   instance assembly contract. Preserve f64 positions until deliberate display
   narrowing, carry flat-corner normals distinctly, and retain strict failed-face/
   topology/refusal information. No second mesh assembly implementation per engine.
8. Complete resource/supervision integration before production activation. Native
   supervisor deadlines/kill/reap and browser worker termination are implemented;
   process RAM limits, kernel internal allocation bounds, multi-worker scheduling,
   app asset delivery and retained-output/cache residency remain separate gaps.
   A byte-limited transfer is not a heap/process limit. Do not advertise this
   boundary as production-ready merely because the exact default path still passes.

Suggested target files: document/{types,mod,validation}.rs plus new small retained
source/result modules; common program constructor/operation enums and request/effect
identities; processing authored_geometry admission and canonical presentation packets;
native adapter include/src/protocol and new curve/sweep helpers; runtime protocol,
worker/supervision command types and mesh result metadata; browser module-worker host
binding/asset owner. Existing exact kernel and public mesh/analytic/USD/IFCX consumers
remain unchanged except additive adapters actually used by the opted-in evaluator.

## Required positive qualification before claiming retained capabilities

- Pin exact upstream/build/compiler/artifact/license-input receipts on native and
  WASM; run the actual newly exposed SDK producers, not transport peers or only
  a Rust protocol compile. Every optional missing SDK/asset/corpus case is a named
  unavailable requirement. No fresh runtime qualification is claimed here.
- Extrude a genuine rectangle, circle, curved boundary and holed profile through
  retained curves/surfaces; compare independent analytic bounds/volume/sections,
  source parameter preservation and topological orientation. Verify surviving
  cylindrical/plane surface types, not only a tessellated triangle count.
- Sweep straight/circular/composite/nonplanar paths and hollow sections with
  explicit cap/trim contracts; independently verify sections/radii/volume where
  available and document unsupported joins. Verify failed construction deletes
  temporary curves/solids and preserves reused input definitions.
- Run retained boolean/opening operations on constructed authored sources: analytic
  box/cylinder controls plus real model witnesses. Check operands immutable on
  success/error, empty versus refusal, grouped/ordered cuts, cavities and units.
  A numerical integration volume alone is insufficient as an oracle.
- Verify object-local reuse, repeated mapped occurrences, nonuniform transforms,
  mm and large survey placements with independent f64 world invariants. Require
  actual instance/template and material/UV/layer/text witnesses, not class flags.
- Test document revisions, delayed completions, worker restart, source/handle
  release, cancellation/deadline/queue refusal and failed staged uploads through
  actual workers on both hosts. Fault peers qualify transport faults only.
- Qualify new retained USD output via an actual schema/stage consumer and preserve
  existing IFCX composition/mesh USD behavior separately. Asset reference equality
  alone does not prove asset resolution or rendering fidelity.
- Keep full exact-default workspace/Clippy/WASM/Python/custom callback and borrowed
  consumer regressions, plus complete-scene comparisons and end-to-end worker-pool
  measurements. Retained improvements are new supported contracts, not byte pins
  forced onto exact mesh output. Heavy validation follows mandatory fleet admission;
  actual refusal blocks a new runtime claim rather than authorizing a bypass.

The next implementation should be one coherent authored evaluator slice: genuine
curve/profile admission -> retained construction -> immutable worker result ->
revisioned tessellation -> existing assembly, with its source-only/final-net status
explicit. Expanding a box opcode or retaining an already-finished Mesh is useful
infrastructure, but neither closes this authored integration seam.
