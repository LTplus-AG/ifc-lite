<!-- SPDX-License-Identifier: MPL-2.0 -->
# Candidate affine rational BRep copy

Status: IMPLEMENTED, UNQUALIFIED. Parent e98406f5dffe4591e41b80d8fc841e29a1b056ab.
Historical native 3af451ceee evidence (4 CTests, 21 regions) remains source-bound
and does not qualify this extension. No common mapping/product/processing files
are changed. Full P1 affine preservation remains open until actual execution,
independent review, common occurrence integration and browser qualification.

Opcode17, ABI/protocol v1 and its proper-rigid acceptance contract are unchanged.
New opcode18 is session u64, source WireHandle, 16 column-major LE f64; result is
new WireHandle plus certificate (u32 version=1, representation=1, twelve u32
class counters). Capability bit4 signals implementation, never qualification.
Original caller matrix is retained in sealed Rust operation identity. The copy
acts on evaluation-space coordinates; unit conversion and placement composition
remain the common executor's responsibility, not this numerical seam.

The certificate means exact-rationalizable representation conversion into a
**generic rational BRep**, with floating point numerical transformation. It is
not exact arithmetic or a claim that SVD returns exact transformed coefficients.
Counters list unique original geometry objects: curve BSpline, Line, Circle,
Ellipse, Parabola, Hyperbola; surface BSpline, Plane, Cylinder, Cone, Sphere,
Torus. These supported analytic classes inherit SDK rational representations.
All other classes, including offsets, curve-on-surface/composites, and specialized
extrusion/revolution surfaces, refuse (status7) before copying/conversion. Missing
materialized rational coefficients also refuse. These remain preservation gaps;
no source tessellation, fitted substitute or automatic engine fallback is used.

Pinned SDK primary sources inspected at clean
`c9c5979f04cea8c38213004d4f04df0dcfb40d05`:

- `source/SM_API/src/SmApiQueries.cpp:1011`, `SmBrep.cpp:673`: the public
  copy wrapper returns success even when the copy constructor discards a failing
  MergeBrep status. The adapter now uses checked public MergeBrep(FALSE) for
  affine, rigid17 and Boolean copies. Composite/specialized faces/edges refuse
  before copying because MergeBrep explicitly does not support composites.
  Tiny pin-specific legal protected-member-pointer helpers preserve all three
  raw Brep tolerance fields, including DEFAULT sentinels, without casts or SDK
  edits; the shared context's exact raw fields are restored after construction.
- `source/SMLib/src/SmBrep.cpp:32782`: TurnToNURBS directly copies rational
  subclasses, but fits offset surfaces and non-rational edge curves, ignores
  some approximation statuses, and deletes UV trim caches. The class whitelist
  excludes every approximation branch. Explicit conversion status and resulting
  generic classes are checked before transforms.
- `SmBSplineCurve.cpp:196`, `SmBSplineSurface.cpp:309`,
  `SmNurbsCrv.cpp:386`: copy constructors normalize close knots. Read-only source
  inspection rejects distinct knots less than max(actual SDK scaled zero,
  SM_EFF_ZERO for curves / SM_EFF_ZERO_PARAM for surfaces), so copies must not
  merge/spread source knots. Repeated equal knots are allowed.
- `SmAxis2Placement.cpp:768`: SetFrom4x4 ignores Z. It is never used here.
- `SmMatrix.cpp:1718`: checked SVDecompose gives U, singular values, V (despite
  an inconsistent header parameter name), A=U D Vt.
- `SmBrep.cpp:28618`: arbitrary-matrix Transform ignores SVD status, uses Mirror,
  and eventually CopyAndAddAnalytics. It is never used here.
- `SmBrep.cpp:28777`: proper placement plus signed scaling transforms geometry;
  negative scale reverses radial edgeuse pairs and swaps faceuse shells.
  Calling it on converted generic geometry avoids specialized analytic formulas.
- `SmBSplineSurface.cpp:5246`, `SmBSplineCurve.cpp:6806`: generic rational
  transformations apply the supplied proper frame and scale to rational data.
  `SmBSplineSurface.cpp:924` analytic recognition is deliberately avoided.

Numerical policy fixed before execution: finite matrix entries |x|<=1e9, affine
last row exactly [0,0,0,1], nonsingular; singular values [1e-6,1e6], condition
number <=1e6, orthogonality max residual <=1e-12, reconstruction max residual
<=128*binary64 epsilon*max absolute linear coefficient. Singular/nonfinite input
is status1; unsupported conditioning/representation is status7; failed SDK or
residual checks are status4. No tolerance is widened after observing results.
SVD orthogonal factors become two proper frames; sign flips are absorbed in
signed diagonal scaling. Translation is applied last. SDK global/model tolerance
rescaling is disabled (bScaleTol=FALSE), preserving source tolerances and avoiding
ambient context mutation. Extreme model scales can still fail later operations;
this bounded domain is not full arbitrary-scale preservation.

Read-only eligibility precedes copy. No output handle/certificate is published before all stages and finite
geometry inspections succeed. Preflight refusal leaves the source usable.
MergeBrep can allocate topology before inserting it in the result, so a failed
copy cannot honestly promise destructor-only reclamation. Any failure after SDK
copy/conversion work starts taints the entire captured isolation domain: additive
C ABI status8 preserves the initiating error, every subsequent status-returning
C ABI call rejects8, native clients terminate/reap the captured process and the
browser driver retires the Worker. Unlinked allocations are deliberately left
untouched until process/module disposal reclaims them. Ordinary synchronized
geometric status4 does not acquire blanket retirement semantics. ABI/protocol v1
layouts and rigid17 accepted matrices remain unchanged; status8 is an additive
failure extension. Unsupported/invalid preflight statuses remain7/1. A
successful copy owns geometry independently of source release. UV trim caches
are invalidated by SDK conversion and regenerated by downstream SDK queries;
this is not persistent face identity, and certificate counters are not face IDs.

Native sealed receipt retains actual input handle, exact matrix, conversion
certificate, full immutable Definition/AffineCopy/Boolean lineage (including raw authored
RetainedRequest and actual source/evaluation frames) and actual owner/object
liveness. Source, dependency-result and affine-copy inputs use the same explicit
transform-input enum. Chained operations are bounded to 128. Baked copies enter
Boolean dependencies only with an explicitly supplied proper-rigid
world_from_affine frame and a Placed lineage node; file units or RTC never infer it.
Receipt Drop does not retire the worker; the session owns the allocation until
explicit worker.release(copy.solid()) or session destruction. Browser receipts
use captured owner/object identity, asynchronous independent release and the same
certificate. Foreign/stale admission occurs before dispatch. Unknown transport
outcomes retire the captured browser domain; validated synchronized SDK refusals
retain source leases. No retiring completion is cloned.

`tests/affine_tests.cpp` is wired into existing owned-boundary CTest. Actual box
and rational cylinder cases cover positive/negative uniform scale, nonuniform
scale, shear with independent Z and reflected shear. Oracles inverse-map returned
points to analytic planes/cylinder sections, compare positive signed triangle
volume to |det| times authored volume, test outward winding against independent
inverse-transpose analytic normals, verify normal streams and opposite edge
incidences, and release original before querying copy. Fixed BRep volume relative
tolerance is 1e-5; display volume 1e-5 box / 1e-3 cylinder, source-plane distance
1e-7, squared radius residual 1e-6, flat-normal residual 1e-10, at specified
moderate transforms/chord0.001/angle5. These tests do not certify arbitrary models.

Remaining required alternatives: (1) extend exact class certificates for additional
SDK rational subclasses after inspecting their coefficient construction and
copy/parameter contracts; (2) represent non-rational offset sources by explicit
immutable source + affine operator with exact evaluation/inverse-transpose normals,
then supply qualified intersection/Boolean/trim consumers for that representation;
(3) add a separately selected approximate conversion contract carrying fit/error
bounds and source lineage, requiring product approval because it does not satisfy
exact analytic preservation; or (4) select an independently qualified exact BRep
backend with a supported affine/offset representation. None is implemented or
silently selected here. SDK modification and mesh replacement are excluded.


The owned-boundary executable runs `copy_failure_tests.cpp` last. It copies a
real SDK box, verifies unchanged context metadata and DEFAULT inheritance after a
later context change, then replaces one actual UV trim by a derived rational
curve whose Copy returns SM_ERR. This is deterministic failure injection into
real SDK MergeBrep, not a mock geometry return. The witness demands terminal
taint, preserved original trim and rejection of unrelated C ABI handles and
session reset. It must execute last because the module intentionally cannot
recover. These new witnesses remain unexecuted until normal native qualification.
