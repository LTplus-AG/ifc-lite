<!-- SPDX-License-Identifier: MPL-2.0 -->
# Unary finite plane clipping, source contracts v1/v3

Disabled infrastructure for #7955. Exact remains default. This port requires
new SDK qualification; historical integration results do not qualify it.

## Operation and authority

Opcode20/capability64 adds `ifclite_smlib_clip_plane`. Existing17 proper rigid,
18 affine rational,19 Empty and their contracts remain intact; capabilities
include bit 64. Paired splitting is not implemented or advertised.

One ordered actual retained input produces one independently owned output in
the same local metre frame. The original six finite doubles are point XYZ and
nonzero normal XYZ. `side=+1` selects `dot(normal,x-point)>=0`; `side=-1`
selects the opposite side. Intersection keeps that side; Difference keeps its
opposite. These are regularized solid operations, with shared boundary points
permitted. Neither Union nor a full-space/unbounded result is represented by a
finite host clip. IFC AgreementFlag lowering remains the common source owner's
responsibility; this ABI does not invent an IFC source occurrence or recipe.

The source normal is never rewritten. Overflow-safe normalization and a stable
cross-product basis are explicitly derived numerical data; the effective basis
is recorded separately. Its normal has a per-component residual gate of64
binary64 epsilons relative to the derived normalized normal. This is a
toleranced SDK numerical operation, not exact arithmetic certification. The
requested point remains the cutter base's exact stored origin. No clearance,
epsilon, tolerance or retry moves that clipping plane.

The returned certificate binds original input/output session, slot and
generation, original plane, side/mode, unchanged-frame discriminator, effective
basis, finite bounds, cutter extents, clearance, topology/ coefficient counts,
actual Empty classification and all admitted cylinder coefficient records.
It is output-only private boundary evidence: no API accepts a caller-provided
certificate as authority. The consuming runtime must seal it under the actual
process/module incarnation and issued operation and keep the original input
lease through output acceptance. Cross-process equality of numeric handles is
not identity. The Rust runtime seals this evidence with the same worker owner and an independently managed output lease.

The wire request is exactly92 bytes, including the12-byte protocol header.
`Reader::end` rejects trailing/short packets before numerical work. Success is
324 bytes plus136 per actual cylinder record, at most2500 bytes for16 records;
only live records are serialized. Fields use existing LE scalar/handle layout.
The certificate follows the output handle: four u32(version/method/frame/Empty),
input/output handles, five u32(side bits/mode/faces/edges/coefficients), original
plane6f64, effective basis9f64, domain6f64, cutter6f64, clearance f64,
cylinder-count u32, then records. Each record is four u32(source face index,
swapUV,insideOut,reserved0), origin3f64,basis9f64,radius f64,STEP V2f64.
Arrays of bounds are loXYZ followed by hiXYZ. C struct padding is not wire data.

## Finite domain proof

The certificate's method field is a bitmask of actual source proofs:

- **1, analytic plane:** Existing positive-weight rational UV trim control
  hulls bound every complete outer/hole trim. Bounded outer-loop interiors lie
  in that convex UV rectangle. Apply the actual `SmPlane` origin, raw axes and
  UV scales with outward interval arithmetic. This bounds the face interior
  of an otherwise unbounded supporting plane. No sampled edge/vertex box or
  unbounded-plane NURBS conversion is substituted.
- **2, generic rational patch:** Exact type `SmBSplineSurface`, existing
  materialized coefficients, non-power-basis form, disabled extrapolation,
  valid finite clamped knots, strictly positive weights, finite actual face UV
  domain within supported knot domain, and actual existing UV trim hulls within
  that domain. Nonnegative B-spline basis functions form a partition of unity
  there: the full Cartesian control hull bounds every face-interior point.
  Method2 rejects missing trims instead of fitting or trusting a flag. Endpoint knot
  multiplicity is degree+1; knot count equals controls+degree+1, with finite
  nondecreasing knots and a nonzero interval. Thus the knot array's first/last
  values are also the supported clamped interval endpoints.
- **4, bounded analytic cylinder:** Exact dynamic type `SmCylinder` or
  `SmCone` with actual canonical angle **exactly0**, live
  materialized conversion data and bounded generator, disabled extrapolation,
  finite nonzero actual natural/face UV domains and finite STEP interval,
  actual canonical cone angle exactly0, positive finite radius and known UV
  conversion flags. `SmCone::EvaluatePoint` converts NURBS UV to STEP and calls
  `EvaluateSTEP`, whose active clamp restricts V to the stored finite STEP V
  interval. With angle0 every result is `O+R*cos(U)*X+R*sin(U)*Y+V*Z`.
  The outward interval image of `O+[-R,R]*X+[-R,R]*Y+[Vmin,Vmax]*Z` therefore
  covers the entire surface, including every trimmed interior. This uses the
  actual raw basis; it does not assume unit axes or sample trig extrema. The
  certificate records O, XYZ basis, radius, STEP V endpoints, UV flags and
  actual revision-local source face index for each such face. At most16
  cylinder records are admitted. That index is not durable face ancestry.
- **0:** canonical semantic Empty; its finite domain is the empty set.

The complete actual BRep boundary is covered, including full positive rational
edge hulls and actual vertices, expanded by the maximum observed source
topology tolerance. Faces/edges/vertices are bounded to100000 each, controls to
1000000, degree to64, and face loops/edgeuses to8192 per scope. Invalid,
unmaterialized, nonpositive-weight, unclamped, extrapolating, out-of-domain,
composite or unsupported geometry refuses. Other specialized analytic classes
remain open. The infinite material region is rejected. A finite closed
boundary with void infinite region confines its material to the boundary's
conservative Cartesian box. Display tessellation is never domain authority.

`GetControlPointsPointer`, used here, returns homogeneous XYZW for rational
data, so division by positive W occurs exactly once (`NL_NOW` means ordinary
Cartesian non-rational data). By contrast `GetControlPointNet` and
`GetControlPolygon` already return Cartesian coordinates; they are not used.
The source implementation, not only the declaration, confirms this distinction.

## Cutter, ownership and outcomes

Interval arithmetic uses IEEE binary64 round-to-nearest, gradual underflow,
outward `nextafter` after each elementary rounded operation, and disabled FMA
contraction/fast math. Projection uses an interval inverse of the stored basis,
not an assumption that rounded basis vectors are exactly orthogonal.

Six checked planar faces make a closed finite clipping operand. The cut face
uses the original point and negative/positive UV extents. Only the other five
walls expand: the declared initial clearance is16 times the observed source
tolerance, rounded outward. **The factor is not a sufficiency certificate.**
After SDK stitching the adapter verifies the actual cut-face origin/basis and
interval-tests the actual other five plane equations against the entire
conservative input box, with strict source-plus-cutter tolerance clearance.
An insufficient or rounded-inward enclosure fails, without moving the cut or
retrying a larger guessed box. Tiny/survey/extreme domains may consequently
remain refused pending numerical qualification.

The source is read-only. Domain preflight does not compute source volume:
integration can lazily create missing UV trims. Copies use existing checked
MergeBrep copying. The derived cutter and copied host are the only destructive
Boolean operands. On success the cutter is consumed and the result must equal
the copied host pointer. Any uncertain copy/construction/destructive outcome
abandons possibly unlinked allocations and marks the whole domain tainted;
status8 requires process/module disposal, never retry or fallback. No partial
handle/certificate publishes. Managed per-object lease contracts remain with
the consuming runtime.

Canonical Empty uses `semantically_empty_brep`. Nonempty outputs require
pointer validation **including zero recorded SmAssertArray failures**, actual
manifold status, a void infinite region and finite positive SDK-integrated
volume. Cutter validation runs on owned data. These checks are actual boundary
observations; neither capability64 nor the certificate qualifies preserved
whole-product geometry, material appearance, source faces or layers.

## Read-only preflight and conversion limits

Source preflight restores shared raw context metadata and never calls SDK
validators or volume on the source. Those can build missing UV trims lazily.
Validation runs on owned copies after domain admission. The preflight fixtures
exercise present-but-unmaterialized trims using a base `SmBSplineCurve` and a
subclass that counts attempted lazy materialization. Neither fixture performs
volume integration; both require refusal without evaluating the invalid trim.

Actual primitive cylinders may carry zero-angle `SmCone` surfaces. Domain
classification checks their raw angle, generator, finite STEP interval and
conversion flags; a nonzero-angle cone refuses. Affine rational conversion may
invalidate UV trims; missing trims require the separate exact rectangle proof
below or refuse. A disabled-extrapolation flag never supplies domain authority.

## J1a checkpoint scope and fixed qualification tolerances

At the J1a checkpoint only v1 was accepted. Missing owned trims, including the
known second clip of a box, refused with synchronized status7 and preserved
inputs. J1b's candidate method below replaces that refusal only for its proved
rectangle class; qualification is still required. Empty inputs can be copied
without another trim. Bounded/boxed halfspaces, general chain support, paired
splitting, product integration, persistent IFC face identity, viewer/CLI
activation and licensing remain required release work.
No error triggers an exact retry or publishes a partial retained product.

Before SDK runs, native analytic volume comparisons retain the source witness
threshold `max(1e-12, abs(expected)*2e-5)` (covering tiny and survey solids);
the independent chord-approximated closed mesh uses `abs(expected)*2e-3`.
Native section/plane checks retain their source thresholds. Rust runtime
analytic volume comparisons use absolute `1e-6` cubic metres for the metre
box and cylinder. Both request SDK volume integration precision `1e-8`.
Display tessellation uses chord `0.001` metres and angle `5` degrees.
These are different contracts; no threshold may be relaxed after a failed run.

The owned-boundary CTest invokes plane preflight and positive analytic tests.
The geometry-platform workflow runs native and Emscripten CTests and all Rust
runtime tests with an actual worker path. A skipped SDK test is not a pass.

### Independent native face and patch witnesses (#7955 review)

`smlib_plane_cylinder_oracle` observes `certify_plane_face_domain`, the same
internal contribution used by BRep certification, before any edge/vertex
union or tolerance expansion. A rigidly rotated actual cylinder supplies raw
non-axis-aligned coefficients. The independent extrema use `hypot(R*X,R*Y)`
and axial endpoints; actual evaluations additionally cover interior angular
extrema and axial endpoints/midpoint in both UV states. Point/formula agreement
uses absolute `1e-10`; containment/extrema checks allow no under-enclosure.

`smlib_plane_patch_oracle` preserves a box top's existing trims and elevates
its patch to degree two in each direction. It checks the unit-weight affine
XY control lattice and changes only the middle control height from 2 to 6.
Thus the top is `z = 2 + x(2-x)y(2-y)`. Its volume is `88/9`; the actual
Intersection retaining `x >= 0.5` must have volume `15/2`, a method2 certificate,
and a closed oriented mesh on the source boundary or cut cap. Source volume
is checked after clipping so volume integration cannot prime admission.
Boundary coordinates use absolute `1e-6`; analytic and mesh volumes retain the
thresholds above. This witness claims **unit weights only**; non-unit positive
rational weights remain unqualified by this successful-clip test.

The geometry-platform native lane invokes `tests/plane_mutation_oracle.py`
with its configured build directory. It follows the existing reverse-applied
`.oracle.patch` convention, since the central revert runner does not dispatch
C++ tests. It requires green controls, then separately drops a radial term,
drops the axial term, and refuses method2 clipping. Each must reach its named
assertion, not a compile error, timeout or crash; each patch is restored and
the control rerun. These are executable qualification requirements, not a claim
of SDK success before the native and Emscripten runs have completed.

## J1b owned affine-domain extension (qualification pending)

Issue #7955 requires chained cuts and nonempty affine-of-clip. The observed
identity-middle edge has Cartesian non-rational controls `-5-2^-49` and
`1-2^-49`, topology endpoints -5 and 1, and parameter support [0,1]. Its
required exact endpoint parameters have denominator `3*2^50`. They are not
binary64; exact topology/control equality is false. `NL_NOW=-DBL_MAX` is the
SDK non-rational sentinel, not a negative rational weight. Neither a tolerance
nor an interval containing both endpoints proves an exact rectangular face.

### Ownership and preparation

`PreparedPlaneOperand` is an operation-local, noncopyable owner. No persistent
Slot cache, certificate input, raw-pointer ancestry map or replay token exists.
The source remains live throughout the synchronous call. A read-only preflight
checks the complete existing inventory before copying: known materialized
surface/curve dispatch, finite bounded coefficients and knots, ownership,
edge parameter support, and complete topology. Missing trims are eligible only
on unit-weight degree1 2x2 generic surfaces with independent signed coordinate
axes, four distinct straight side edges, positive rectangular vertex topology,
and exact common side/plane coordinates. Along-edge endpoint gaps may use only
the existing edge/vertex tolerance budget; no 3D coordinates, intervals or
source tolerances are edited. This is reconstruction eligibility, **not** an
exact closure or interior proof. A single displaced vertex, warped net,
unknown class, foreign owner or missing representation refuses before copy.

Checked `MergeBrep(..., FALSE)` supplies an explicit topology map. Exact bounded
value inventories compare the copied geometry, topology, UV data and source
face association, rather than just object counts. The temporary copy map is
used only while topology remains unchanged and then discarded. Inventories
store full values (including binary64 bits), not a lossy hash. No method depends
on GetFaces enumeration order; cylinder indices are mapped back to the source.

On the owned operand, each originally missing face explicitly calls
`CreateUVTrimCurves(FALSE, ...)`. Full pointer/manifold/loop/volume validation
finishes before domain certification. Reported sampled projection errors are
not proof inputs. The complete resulting inventory is re-read and unknown,
omitted, foreign, unmaterialized or unsupported trims refuse. Core topology,
3D coefficients, intervals and tolerances must still equal the source through
the copy map. Source inventory must remain byte-exact. Reconstruction failure
abandons the partial owned graph and poisons the isolation domain.

### Inventory seal scope and opposite-side topology (#7955 OWNED-DOMAIN-01)

Both loopuses of every loop are inventoried, including their identities,
orientations, reciprocal mate/faceuse owners, type, initial edge and linked-list
adjacency. Each side's actual CCW edge cycle is visited with a bounded visited
set; unknown loop/edge/vertexuse types and open or repeated cycles refuse.
Every edgeuse records its orientation, edge owner, mate/radial and raw list
neighbors, CW/CCW relations, vertexuse and back-links. Every vertexuse records
its type, vertex owner, edge/loop/faceuse links and vertex-list neighbors.
Faceuse loop membership and whole-BRep edgeuse/vertexuse sets must equal the
visited inventory. Copied identities are still compared through the SDK map;
normalization or changed adjacency is not excused.

The bounded evaluator-metadata audit additionally seals the face's raw
`GetRectangularTrim()` classification and surface point-solver selection.
The former is UV-derived, so owned reconstruction may update it before the
seal; source preservation, mapped copy and the final seal still compare it
exactly. The latter is core policy: the SDK copy constructor resets it from a
global default, so a source with a different policy **refuses**, rather than
silently accepting normalization. Valid tri-state values remain distinct;
invalid enum values refuse. A saved DropCurve failure is rejected, because it
can change the status returned for an existing trim without changing its
coefficients. These getters do not evaluate or lazily generate geometry.

This inventory covers the admitted geometry, reciprocal topology and explicit
policy fields listed here. It is **not** a byte snapshot of every SDK object,
cache, callback or attribute. Gap caches, traversal marks, graphics caches,
user attributes and Notify callback registration are not sealed; no authority
is derived from them. In particular, the commented-out `SmVertexuse::m_sUVPoint`
fast path is not an admitted evaluator input at this SDK pin. The adapter's
synchronous prepare/consume path and unexposed raw SDK handles remain part of
the contract; arbitrary external cache/callback mutation is not certified by
these comparisons. Known representation dispatch stays whitelisted and opaque
failure state refuses. No cache getter that can compute or refresh a gap is
called to manufacture an immutable-source claim.

### Coverage theorem and numerical boundary semantics

For every completed face, all actual trim spans must lie within their complete
positive-weight clamped control support. Their UV control hull therefore
contains their full images, not just sampled endpoints. A finite rectangle
containing every segment and endpoint also contains every straight endpoint
connector and the bounded interior of the resulting numerical loop. No exact
endpoint equality is inferred. This corresponds to pinned c9c5979
`SmFace::CreateOrientedTrimBoundary` (7290-7410), which copies the complete UV
curves and can insert straight gap connectors. `CreateUVTrimCurves` may first
project and adjust endpoints; those changes occur **before** inspecting the
inventory. Unknown/non-bounded reconstruction results refuse.

The SDK also classifies and searches using the face's explicit finite UV
domain. Its complete rectangle is unioned with the full trim hull, so this
numerical parameter restriction cannot silently crop or escape the enclosure.
No cached 3D BBox, inferred intersection subset, snapped UV or partial set of
curves supplies authority. Existing source-side exact-rectangle readers remain
strict and independently tested; they are not the missing-trim clip path.

For the eligible axis-affine map, polynomial extension is valid on this entire
finite UV envelope, even outside natural support:
`P00 + (u-u0)/(u1-u0)*(P10-P00) + (v-v0)/(v1-v0)*(P01-P00)`.
Outward interval subtraction, reciprocal, multiplication and addition enclose
the full image. The normal coordinate is exactly constant. All actual edge
control hulls and vertices are separately unioned, followed by the existing
source-tolerance expansion. Generic curved patches retain strict method2
containment; the owned path does not grant arbitrary extrapolation.

The final owned inventory is sealed after all validators and domain reads.
Cutter construction then runs. Immediately before Boolean use, the source
inventory and exact owned inventory are compared again; another BRep, an
omitted trim, a one-ULP edit or a second consume refuses. No operand evaluator
or validator runs between this check and Boolean. The Boolean consumes that
same owned BRep, not another copy. Output validation remains separate. Source
immutability is rechecked before publication, and poisoned domains retain the
existing abandonment policy. Handle generation/session checks remain at the ABI;
release and slot reuse cannot retain this operation-local authority.

### Versioning and consumers

Bit8/version3 now explicitly reports this **owned affine-domain enclosure**,
including originally missing trims, even if reconstructed UVs happen to fit
method2 support. It no longer promises the earlier experimental exact rectangle
interpretation. Native header, Rust decoder documentation, Worker contract and
this guide change together; deploy them together. This is an output-only native
attestation, not a serialized proof or caller authority. The wire mask,
`312 + 136*cylinder_count` layout, maximum2488 bytes and all identity/frame/
plane/count checks remain unchanged. Version1 is still required without bit8;
historical version2 rectangle-record packets still refuse. No new public Rust
symbol or protocol input is introduced.

### Fixed oracles and execution

`plane_chain_tests.cpp` and the actual browser Worker
`plane-chain-contract.mjs` use an off-centre4x6x8 box and a nonuniform
2x3x0.5 affine input, both locally and at (5000000,-2000000,100). Three
successive coordinate-midpoint cuts retain 1/2,1/4,1/8 volume. Both direct chaining and an identity affine
copy of the first clip consumed by the second are required. Tests assert each source
still has its original geometry, then release all predecessors and recheck the
last result. Independent rectangle formulas give extrema and centroid; mesh
moments use tetrahedra relative to the expected lower corner to avoid survey
cancellation. Query tolerance1e-8, analytic volume max(1e-12,2e-5*volume), mesh
volume2e-3*volume, coordinate bounds and centroid absolute1e-6, chord.001m and
angle5 degrees are fixed before execution. No tolerance has been widened.

The existing CTest graph invokes the native and Emscripten chain target. The
existing Chromium Worker probe stages and invokes the new JS witness. The
native mutation step additionally removes affine extension, its production
bound union, and the exact warp predicate separately, requiring the named semantic assertion with exit1;
compile failures, crashes or timeouts are not mutation kills. Existing cylinder
and patch oracles/mutations remain separate and unchanged.

The separate `smlib_plane_owned_domain` CTest covers reconstruction, source
immutability, foreign ownership, omitted trims, one-ULP edits, unknown curves,
release and one-shot consumption. Opposite loopuse, nonprimary mate edgeuse,
source-side orientation and evaluator-policy edits must refuse, restore and
recover the identical valid inventory. CI separately invokes
`tests/plane_owned_mutation_oracle.py`: omit the owned UV image bound, omit
method8 provenance, bypass the final inventory seal, and omit the opposite loopuse orientation. Each needs its named
semantic assertion, green controls and restoration; these do not replace the
six existing geometric or six wire mutations.

All SDK, Rust and actual Worker numerical tests are **UNRUN** at implementation
handoff. The preserved original 3c06 diagnostic run is red at identity-middle
cut1. Parent qualification must observe the unchanged eight positive chain
oracles, including method8/v3, pass at the repaired source. Refusal is not a
passing skip or completion of the required feature.
This does not implement arbitrary rotated/sheared rectangle proofs, curved
chain preservation, bounded halfspaces or retained product/viewer activation.

### Curved intersection construction accuracy (#7955)

Finite-plane clipping now calls the SDK's user-level `SmMerge::ManifoldBoolean`
with explicit approximation precision `1e-6 / 16` in the existing local units.
The plane ABI has no caller precision field: `1e-6` is this private lane's fixed
qualification boundary, not a new user-selectable setting. The source, cutter,
frame, topology tolerances, display chord `.001`, and display angle `5` remain
unchanged. There is one construction attempt and no relaxed-precision retry.
The existing owned-copy transaction still withholds the certificate until all
checks pass. SDK failure or unexpected precision configuration taints the owned
domain and invokes the existing isolation/teardown policy; it does not publish
partial output or run destructors over potentially consumed operands.

The pinned SDK's `SmApiBoolean` omitted this precision argument. `SmMerge`
therefore selected a default from topology tolerances and edge size. Actual
PC evidence at `3c06f525a7522fe2edfdf12738b41b85a47d9a3d` found the failed mesh
point exactly on the retained fitted 3D edge: its residual against the source
patch was `1.1479798693869725e-6`, while the same edge's top-face UV evaluation
had zero residual. The source topology tolerance was `1e-5`; refining display
triangulation could not correct that retained curve.

The construction budget reserves fifteen sixteenths of the fixed boundary
limit for other errors. For the independent unit-weight patch witness, both
horizontal derivatives of the source graph have magnitude at most two, so
its graph residual is at most three times a 3D positional perturbation. This
motivates a construction budget well below the final limit; it does **not**
turn the SDK's sampled span checks into a certified continuous error bound.
No universal accuracy claim for arbitrary curved or near-tangent geometry,
large coordinates, or accumulated chains follows from the configuration.
These remain subject to actual positive source-derived qualification.

The original containment, signed mesh volume, analytic volume and source
preservation assertions remain. `smlib_plane_patch_edge_oracle` also checks
retained edge evaluations against the independent polynomial before meshing.
A test-only Emscripten module executes those same numerical assertions in a
real browser Worker; it adds no production opcode or public ABI. The existing
CI browser probe stages that module only into its temporary test directory.
The native CI mutation runner reverse-applies
`patch-construction-accuracy.oracle.patch` to restore the original SDK default
call. Both the new edge assertion and original containment assertion must fail
semantically, followed by restored passing controls. Compilation failure,
timeout, SDK refusal, or a missing positive baseline does not count as a kill.

Implementation and mutation execution are unqualified until the parent runs
the exact integrated source against the pinned native and browser SDK builds.
