# Unary finite plane clipping, source contract v1

Implementation checkpoint, **not numerical qualification**. Base source is
`23d68a60f4`; inspected SDK is immutable
`c9c5979f04cea8c38213004d4f04df0dcfb40d05`, at
`/tmp/ifclite-public-sdk-c9c5979/usd-brep`. No SDK object code, executable,
Worker, browser or CTest was built/run for this checkpoint.

## Operation and authority

Opcode20/capability64 adds `ifclite_smlib_clip_plane`. Existing17 proper rigid,
18 affine rational,19 Empty and their contracts remain intact; capabilities
become123. Opcode21/capability128 is a **design reservation only**, with no
implementation, declaration, dispatch or advertisement.

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
not identity. This checkpoint does not add runtime acceptance or ancestry.

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
  Reject missing trims instead of fitting or trusting a flag. Endpoint knot
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

## Shared context correction after independent review

The default `SmBrep` constructor (`SmBrep.cpp493`) invokes setters that
propagate DEFAULT sizing policy into the shared context (`SmBrep.h724+`).
End-of-operation restoration alone leaves the wrong effective policy active
during topology copying and cutter construction. Private `context_metadata.hpp`
now preserves raw size, ratio and zone with legal protected-member pointers,
including sentinels, and restores the shared context immediately after each
adapter-owned BRep constructor, before any adapter geometry/tolerance work.
Both checked-copy and the whole clip also have exception-safe outer guards.
Raw BRep metadata is copied directly without propagating public setters.

The inspected `MergeBrep` body copies topology/geometry without a BRep
constructor or sizing setter. Supported `ManifoldBoolean` Intersection keeps
its input BRep; its direct new-BRep extraction branch is for
SM_BO_EXTRACT_SEPARATE, which this seam does not invoke. Its temporary rebase
uses translation without an optional scale; the tolerance-changing branch of
`SmBrep::Transform` requires an optional scale and bScaleTol. The guards also
restore context on all clip exits, including numerical failure/taint.

New actual shared-context witnesses use nondefault and DEFAULT raw metadata
for context/source/sibling, compare raw scalar bits and effective tolerances,
and cover nonempty, full-removal Empty, empty-input and refused operations. A
virtual trim Copy observer checks the policy inside real MergeBrep, then
delegates actual SDK geometry copying. These witnesses are UNRUN here, and the
existing isolated poison witness is unchanged.

## Source preflight correction after independent review

`SmBrep::ValidatePointers` is evaluating even at LEVEL_0: its UV checks at
31566-31590 call `EvaluatePoint` on present trims. A present generic curve
without NURBS can enter `GetOrCreateGwNurbPointer`, ignore failed MakeNurb, and
dereference a null representation. A derived curve could instead materialize
and mutate source data. Missing trim pointers alone do not cover this case.

Source certification now performs non-evaluating class/pointer/materialization
preflight over every source face, 3D edge, existing edgeuse trim and cylinder
generator. It rejects unknown or present-but-unmaterialized representations
with status7 before coefficient access or any SDK geometry validator. It uses
only SDK-constructed topology getters, raw representation pointers, actual
coefficient/domain reads and non-evaluating topology checks. In this pin,
`SmBrep::IsManifoldSolid`11246 and `SmEdge::IsManifold`4722 inspect topology
only; `SmLoopuse::IsClosedPtrs`917 follows pointers only. Source-side geometric
closure/ValidatePointers calls are removed. Full pointer-report, geometry and
volume validation runs on the owned checked copy before Boolean work, and on
the owned cutter/output, preserving the existing numerical oracles.

New actual SDK negative witnesses attach a present default-constructed generic
UV curve with null NURBS to real box topology. They exercise direct domain and
clip entry, require status7, unchanged trim identity/null representation, raw
source/context metadata, topology counts and vertex scalar bits, and no taint.
A second present derived trim observes that MakeNurb is never invoked; it
supplies no successful geometry. These are rejection witnesses, not positive
geometry completion evidence, and remain UNRUN until parent execution.

## Actual BRep cylinder overload correction

The pinned `SmApiPrimitives.cpp383-393` BRep overload of
`SmApiCreateCylinder` delegates to `SmApiCreateCone` with equal base/top radii.
That overload at461-503 calls `SmPrimitiveCreation::CreateCone`; the analytic
creation path (`SmPrimitiveCreation.cpp738-768`, with `USE_NEW_ANALYTICS`
defined at35) selects the helper at647, which creates `SmCone` at662. By contrast,
the surface-only overload at401-453 directly creates `SmCylinder`. The parent's
actual existing-worker diagnostic confirmed that the C ABI cylinder BRep has
one SmCone side and two planar caps. This child did not execute that diagnostic.

Method4 now admits exactly those two dynamic SDK types only when the actual
canonical angle is exactly zero and the radius is positive finite. Nonzero
angles remain refused without a tolerance comparison or approximate conversion.
Both types use the same inspected SmCone EvaluatePoint/UV conversion/EvaluateSTEP
clamp and constant-radius formula. Materialized generator/UV, boundedness,
extrapolation, finite domains, coefficient records and outward enclosure checks
are unchanged; no wire layout, capability or runtime contract changed.

The actual BRep cylinder-domain witness visits both exact types, verifies the
zero angle, and requires one reached side, eight endpoint evaluations across
the two UV orientations and one observed UV swap. It can no longer pass by
skipping the side. An actual unequal-radius cone must reach one nonzero-angle
side and refuse method4. All previous volume, section, finite containment and
cutter oracles remain intact. The parent owns the separate affine source-class
oracle correction. These new plane witnesses remain UNRUN by this child;
syntax-only compilation against the pinned SDK passes.

## Primary-source findings and remaining split work

All locations below refer to the pinned SDK source, inspected without editing:

- `SmBrep.cpp1009` bounding can return a locked box; an approximate branch
  omits surfaces. `SmFace.cpp848` uses boundary-only bounds for linear surface
  directions. Neither path is used as proof for arbitrary curved interiors.
- `SmBSplineSurface.cpp2857` and `SmBSplineCurve.cpp3955` return homogeneous
  backing coefficients. `SmBSplineSurface.cpp2789` performs division before
  returning its Cartesian net. `SmBSplineSurface.cpp4335` natural domain uses
  first/last knot entries; explicit clamping checks establish their meaning.
- `SmBSplineSurfaceNLib.cpp8683-8747`, `EvaluatePoint`, has its clamp under
  **`#if 0`**, with an explicit instruction not to clamp. Its live evaluator
  passes the original UV to `N_SrfEvalPt`; `IsOutOfBoundsEnabled==FALSE` alone
  cannot certify a cropped/unknown or missing-trim domain. `Evaluate` at8130
  has a different active clamp. `SM_SF_POLYNOMIAL` dispatches to power basis,
  so the positive B-spline hull theorem does not apply to that form.
- `SmCone.cpp1934` handles swapped/inside-out UV conversion;2073 point
  evaluation calls `EvaluateSTEP`;2099 clamps STEP coordinates and contains
  the actual cylinder formula. `SmCone.cpp467` returns raw canonical fields.
  `SmSurfOfRevolution.cpp4569` defines boundedness through the live generator.
- `SmBrep.cpp32782-32973` TurnToNURBS replaces specialized representations.
  Surface replacement can recreate UV trims, but subsequent changed-curve
  `SmEdge::SetCurve` calls invalidate them (`SmEdge.cpp2493`). Missing trims
  after an affine rational copy remain an uncovered preservation class. The
  positive bounded-cylinder route does not qualify that different route.
- `SmBrep.cpp30890-31942` ValidatePointers records failures and can return
  success; both its status and report array are checked.
- `SmApiBrep.cpp208` and `SmMerge.cpp2430-2550` provide the destructive Boolean
  ownership used here. `SmMerge.cpp5050+` finishes operand deletion on success.
- `SmBrep.cpp38618-38721` CutBreps uses unchecked copy constructors, processes
  only the first cutter, and returns `SM_SUCCESS` when its Boolean failed. Its
  outputs are connected face sets. It is not paired-solid success authority.
- `SmMerge.cpp2531` accepts an oriented sheet for SM_BO_SLICE; it returns one
  modified solid, not ordered paired sides. The infinite-region caveat at4906
  also needs qualification. Section curves are not finished clipped solids.
- A possible one-intersection paired route is imprint-and-classify:
  `SmMerge.cpp4060-4156` marks SAVE/DELETE faces on both operands and preserves
  their imprinted topology. It also continues after a confused classification
  at4030. `SmBrep::CopyFaces` at1999 discards a MakeFaceuse status through `SE`.
  A sound implementation still needs checked exhaustive side classification,
  checked extraction/closure, shared interface identity and copy/merge ancestry
  transfer. `SmTopology.cpp269-313` user-index propagation is not by itself an
  exhaustive ancestry certificate. No such paired implementation is claimed.

Two independent unary clips cannot close layer slicing: they do not establish
one shared cut, interface identity, or exact source-versus-generated ancestry.
Existing presentation is an uncapped exterior shell, including opening reveals;
independent closed analytical slabs would introduce internal sheets. Paired
atomic outputs, interface/source provenance and presentation suppression,
polygonally bounded halfspaces, Union/unbounded representation, additional
analytic classes, affine trim loss, cross-target runtime issuance/acceptance,
common openings/layers and whole-consumer preservation remain required work.

## Validation status

Owned C++ sources, C ABI dispatch and new tests pass syntax-only compilation
against the real pinned headers, with `-Wall -Wextra` and no owned warnings.
This does not link or execute SDK implementations. `git diff --check` passes.

The new actual SDK/C ABI witnesses are wired at the end of the existing
`smlib_owned_boundary` executable. Existing CTest boundaries, including the
separate terminal-poison witness, are unchanged. Witnesses cover analytic side
and volume, oblique/tangent/disjoint/coincident/full-removal cases, semantic
Empty, packet bounds, local-frame/source lifetime, closed tessellation and a
section-area oracle, bounded-cylinder coefficients and swapped UV evaluation,
finite source scales/survey placement, and a true rational face-interior bulge
that exceeds vertex bounds. Reflected affine/rational trim-loss refusals are
explicit negative coverage, never completion evidence.

**All new numerical witnesses are UNRUN.** Parent-coordinated integrated SDK,
native/module Worker, real model, cross-target, correctness and performance
qualification is still required. No heavy job, PR, push, target creation,
cleanup or upstream-source modification was performed by this child.

## Private source-derived rectangle candidate (2026-10-19, UNRUN)

This additive candidate is **not enabled in `certify_plane_domain` or the clip
C ABI**. It does not assign a wire method bit, change a parser, create authored
UV trims, alter capability/opcode advertisements, or relabel a generic patch as
`SmPlane`. The parent must independently review the proof and coordinate the
method/certificate integration. The must-pass C ABI witnesses below require that
integration; at this checkpoint the old missing-trim refusal remains a known
production blocker, rather than an accepted test outcome.

The read-only seam is `certify_plane_source_rectangle(source, face)`. It runs
the existing whole-source representation preflight and finite-material/manifold
checks, authenticates the face against the actual source inventory, then calls
`plane_source_proof::certify_axis_rectangle`. Any present UV trim still needs
its original supported, materialized, positive-weight, clamped hull within the
surface knot support. A present but unmaterialized trim always refuses before
any coefficient getter can create it. No evaluating source validator is added.

### Proof and primary-source premises

All SDK references are to immutable pin
`c9c5979f04cea8c38213004d4f04df0dcfb40d05` in
`/tmp/ifclite-public-sdk-c9c5979/usd-brep`:

- `SmBSplineSurface.cpp:2857–2884` exposes homogeneous tensor controls in
  P00, P01, P10, P11 order for a 2x2 net; `:2897` exposes raw knot arrays.
  These getters call `GetOrCreateGwNurbPointer`, so the separate prior raw
  `GetGwNurbPointer` checks are essential. No missing representation reaches
  those getters. `SmBSplineSurfaceNLib.cpp:8683–8747` leaves EvaluatePoint's
  clamp disabled and dispatches non-power forms to `N_SrfEvalPt`.
- Degree one, knot pairs `[u0,u0,u1,u1]` and `[v0,v0,v1,v1]`, and unit weights
  give the exact bilinear tensor map. Coefficient equalities require P00/P01
  to share the U-coordinate, P10/P11 the other U-coordinate, and the analogous
  V equalities, with one further constant coordinate. U and V each vary on
  exactly one distinct coordinate axis. Thus the mixed coefficient vanishes
  exactly, and both affine directions are independent. The map is injective
  on the entire plane; no small residual, sampled planarity, or interval
  containing zero substitutes for equality.
- Its symbolic inverse is
  `u=u0+(X-P00[U])/(P10[U]-P00[U])*(u1-u0)`, and analogously for v. Exact
  order comparisons place every full boundary-control hull inside the two
  spatial endpoint ranges and exactly on the constant-coordinate plane.
  Therefore all inverse boundary hulls lie in the actual knot support.
  The certificate conservatively records that complete supported UV rectangle;
  it does not round or fit a new UV curve. The returned Cartesian bounds are
  the entire proved affine patch hull, not the boundary-only box of an
  arbitrary rational surface.
- `SmBSplineCurve.cpp:3955–3977` exposes homogeneous edge coefficients;
  `:3274–3337` evaluates the generic rational curve. Each admitted boundary
  curve has two unit-weight controls, degree one, four finite clamped knots,
  and a strict finite actual edge interval contained in the entire support.
  Exact endpoint equations authenticate that interval against actual vertices,
  including cropped intervals. Full edge-control hulls, not just endpoints,
  must lie on the rectangular boundary side and inside patch support.
- **SmLine needs a second proof.** `SmLine.cpp:1131–1143` evaluates canonical
  fields after `:459–487` affine parameter conversion; `:838–857` returns raw
  origin, axis, scale, STEP interval and inside-out fields. The candidate
  requires a positive finite scale, one exact signed coordinate axis, a
  bounded strict finite STEP interval, and excludes the actual near-zero
  conversion branch. Exact canonical equations at both knot endpoints prove
  equivalence with the materialized line over the entire affine interval,
  including reversed parameterization. `:796–804` uses the existing NURBS
  natural interval when materialized. Boundedness alone is never the proof.
- `SmEdge.cpp:4498–4520` and `SmEdgeuse.h:65–85` give endpoint and traversal
  conventions. The candidate verifies actual same-face loop/use/mate/edge
  ownership, distinct edges, reciprocal CW/CCW links and exact geometric
  closure. `SmFace.cpp:10190–10220` retrieves primary/upward loops;
  `SmFace.h:108–113` specifies that convention. `SmLoopuse.h:53` identifies
  an outer loop, while `SmFace.h:200–208,303–312` documents positive parameter
  winding for an outer area loop. The candidate independently proves the
  four distinct corners and CCW sequence 00 -> 10 -> 11 -> 01, rather than
  relying on the first/outer flag. Exactly one such simple Jordan rectangle
  bounds the interior. No holes are admitted in this version. The injective
  inverse takes that bounded interior into knot support. Neither an unbounded
  complement nor an incomplete pointer cycle receives a certificate.

`plane_dyadic.hpp` provides bounded source-owned exact equality for the required
sum of products. It unpacks finite IEEE binary64 into sign, integer mantissa
and exponent. Products span bit exponents -2148 through 2047. Separate positive
and negative sums use 136 base-2^32 limbs and at most 16 terms, including headroom
for carries. Each 32x32 partial product fits uint64, is split before shifting,
and propagates carry with explicit bounds. Exact zero is equality of the two
integer arrays. No host extended precision, floating product, FMA, Boost,
sampling, or epsilon-based zero inference is used. Test invariants include
nonzero underflow/overflow products, cancellation preserving the smallest
residual and a one-ULP survey-coordinate discrepancy.

The private `Rectangle` record distinguishes its source-derived proof identity
from an authored trim. It retains source inventory index, the full raw surface
net and knots, axis indices, supported inverse UV hull, complete four edge
control/knot/interval records, actual vertices, canonical SmLine fields when
used, winding/corner records and fixed counts. It is not a retained certificate
for later object generations. Parent integration must bind records and all
existing outward tolerance expansion/resource ceilings to the actual source
incarnation and output receipt. It must not silently publish existing method2
for this different admission proof.

### Qualification plan frozen before execution

New SDK-gated witnesses are wired into the existing `smlib_owned_boundary`
executable, with no additional heavyweight job submitted by this child:

- actual box faces replaced by generic materialized patches with caches
  explicitly absent; identity affine output; a reflected nonuniform affine
  box in survey coordinates; a replacement patch at survey coordinates;
  and generic faces from an actual first sealed Clip Boolean result;
- exact source coefficient/pointer/absent-trim/raw metadata snapshots across
  successful private certification;
- one-ULP near-affine and clearly warped controls, invalid/nonunit weights,
  out-of-support edge intervals, wrong loop side, foreign face ownership,
  and present-but-unmaterialized UV trim refusals;
- C ABI must-pass second consumption of a first Clip, identity affine Clip,
  third Clip after releasing earlier inputs, and reflected survey Clip.
  Existing input/output/frame/request identity, independent volume, side,
  closed mesh, manifold and independent lifetime assertions remain. The
  previously documented survey refusal becomes a positive requirement;
  unsupported curved rational cylinder copies still refuse. Existing
  interior-bulge and lazy trim negatives are retained unchanged.

**Every new numerical test is UNRUN, including syntax/compile qualification.**
Only a whitespace diff check and source inspection were performed. The private
proof may expose a genuine SDK representation gap on execution; record that
failure without weakening or skipping the corresponding positive assertion.
The production source method, source-bound certificate/consumer integration and
actual runtime chain are still held for the parent. No arbitrary externally
edited graph, callback-only ancestry, general affine/sheared patch, nonunit
constant weight, higher-degree net, curved boundary or hole is claimed.
Exact remains permanent/default. Paired partition, layers and appearance remain
separate holds.

## Additive native method8 integration after frozen 5bcc (UNRUN)

The preceding private-candidate section records the immutable `5bcc14113a`
checkpoint. This subsequent additive implementation puts its restricted theorem
into `certify_plane_domain` **only** for an actual `SmBSplineSurface` face with
at least one absent cached UV trim. Complete cached UV domains keep the old
method2 path, byte-for-byte v1 wire layout and all its existing checks. Any
present but unmaterialized/unknown trim still refuses in whole-source preflight.
The old generic route is not weakened; unresolved missing-cache surfaces fail
the restricted proof with status7. No `SmPlane` dispatch, Rust/JS consumer,
capability, opcode or upstream SDK source changes here.

`rectangle_domain` uses the caller's single `PlaneDomain` ledger. Each record
charges four surface and eight complete boundary controls, plus **every**
present trim's control count through the existing `curve_hull` path. The later
complete source-edge pass charges all its controls to that same ledger. No
per-face scratch ledger occurs in production. The standalone per-face research
entrypoint has a fresh ledger because each such call is a separate operation.
The existing ceilings of 100000 source faces/edges/vertices, 400000 preflight
edgeuses and 1000000 charged coefficients remain; a source operation may emit
at most16 rectangle records, independently of the existing16 cylinder maximum.
The seventeenth rectangle refuses with resource-limit status before output.
Source/face/edge/vertex tolerance aggregation and the final outward domain
expansion are unchanged. Individual rectangle records retain the exact raw
patch bounds before that aggregate expansion.

The parent-owned cutter file is deliberately unmodified. The exact assignment
hunk in `/tmp/ifclite-plane-source-records-5bcc-assignment.patch` adds only
`populate_plane_source_records(domain,c);` immediately after its existing
cylinder-record copy. The helper installs method/version/rectangle fields:
version2 iff actual derived records exist, method bit8 iff those records exist;
all other domains, including canonical Empty, use version1 with no extension.
The native C header grows to hold bounded records; native callers must rebuild
against it. Wire serialization remains explicit scalar LE, never C padding.
Until the parent applies that one-line handoff and its owned runtime parsing,
this child does not constitute an integrated C ABI/runtime production closure.

### Exact version2 wire contract

The entire prior successful response prefix, including the original cylinder
records, retains the v1 field ordering and widths. Overall certificate version
is2 only when method bit8 records exist. At response offset
`324 + 136*cylinder_count` (including the12-byte response header), v2 appends:

- four LE u32 fields: `rectangle_count` (1..16), `rectangle_record_bytes=1376`,
  `rectangle_edge_bytes=248`, `rectangle_reserved=0`;
- exactly `rectangle_count` fixed-width1376-byte rectangle records.

Each rectangle record contains, in order:

- twelve LE u32: `record_version=1`, actual input `source_face` GetFaces index,
  `u_axis`, `v_axis`, `normal_axis`, `loops=1`, `holes=0`, `edge_count=4`,
  `control_count=12`, `flags=0`, `reserved0=0`, `reserved1=0`;
- IEEE binary64 arrays: `controls[16]` (raw homogeneous tensor P00,P01,P10,P11),
  `u[4]`, `v[4]`, `bounds[6]` (loXYZ,hiXYZ), `uv_hull[4]`
  (loU,loV,hiU,hiV), `inverse[8]`;
- four fixed-width248-byte edge records in the certified actual loop inventory.

`inverse` is exactly `u0,u1,P00[U],P10[U],v0,v1,P00[V],P01[V]`.
It specifies
`u=u0+(X-P00[U])/(P10[U]-P00[U])*(u1-u0)` and the analogous v expression,
without storing a rounded reciprocal or fitted UV data. Distinct signed axes
and raw endpoint differences authenticate injectivity. The derived inverse UV
hull is the full conservative supported knot rectangle, not an authored trim.

Record byte offsets are: header0, controls48, U knots176, V knots208,
Cartesian bounds240, UV hull288, symbolic inverse320, four edges384.
The last edge ends at byte1376.

Each edge record contains four LE u32: `flags`, `start_corner`, `end_corner`,
`reserved=0`, followed by IEEE binary64 arrays in order: homogeneous
`controls[8]`, `knots[4]`, actual `interval[2]`, actual `start[3]`, `end[3]`,
canonical `line_origin[3]`, `line_axis[3]`, `step[2]`, then `scale`.
Edge flag bit0 means canonical SmLine data is present; bit1 means inside-out;
no other bits are defined. All canonical fields/flags are zero for a generic
linear B-spline edge. Corner codes use U in bit0, V in bit1, so positive
parameter winding is0->1->3->2->0. Geometric start/end fields follow increasing
curve parameter; corner fields follow the oriented face-loop traversal.
Edge offsets are header0, controls16, knots80, interval112, start128, end152,
line origin176, line axis200, STEP interval224 and scale240; total248 bytes.

`source_face` is local to the actual consumed source's current face inventory.
It is **not** persistent ancestry. The enclosing actual input/output native
handles and parent-owned incarnation/operation sealing provide the binding.
No source proof record is accepted from a caller as authority. No rectangle
extension is serialized for v1, including v1 method1/2/4 or Empty. Mixed
old/new faces produce a v2 certificate with bit8 plus the other actual methods.
At both maxima the response bound is24532 bytes:
`324 + 16*136 + 16 + 16*1376`. Request framing remains92 bytes.

### Additional qualification witnesses and actual state

The existing SDK boundary now includes production-domain success for the
replacement, identity/survey affine and actual Boolean fixtures; exact method
and version selection; a six-derived-face 96-control ledger invariant; and a
mixed authored/derived case with102 charged controls, including three surviving
trims on the derived face. A real disjoint union of three boxes supplies18
faces for the seventeenth-record refusal witness. Each of source, face, edge
and vertex tolerances has a distinct owned fixture verifying final outward
expansion. All warped/near-affine/weight/interval/loop-side/unmaterialized trim
negatives now exercise both the private seam and production domain path.
Foreign ownership remains checked against the actual source inventory.

The actual C ABI second-Clip witness requires v2/bit8 and nonzero records;
its protocol companion independently reads every fixed-width field, including
raw homogeneous sentinel bits, all boundary records and inverse fields, checks
exact extension lengths, real result volume/manifold status and release. The
old analytic packet witness still requires a324-byte v1 response with no bit8.
Identity affine and reflected survey replacement-frame positives remain
must-pass, never status7 skips. All existing cutter, manifold, mesh, closure,
volume, source-immutability and lifetime assertions remain.

A host C++17/C11 **syntax-only** check against the pinned SDK headers completed
with exit0 and no diagnostics for the changed native/domain/protocol/test
translation units, including the fixed248/1376-byte C/C++ layout assertions.
This did not link or execute SDK code. All new SDK/C ABI/protocol/runtime and
browser numerical qualification is still **UNRUN**; parent job475 and its
immutable evidence were untouched, and this child submitted no worker job.
The parent's `475c5edca5` source ledger and outward cutter changes must be kept:
apply incremental patches after5bcc and the one-line handoff, never overlay
this child's older full native files. Exact remains permanent/default;
paired partition, layers, appearance and broader affine classes remain holds.

Transport integration hold: although native worker output framing can write the
bounded24532-byte response, current `browser/module.mjs:20` and browser client
response checks reject frames over4096 bytes. Rust's protocol module also uses
`MAX_PAYLOAD_BYTES=4096`. The parent must coordinate a bounded **response** limit
and parsing for v2 without widening the existing request admission. No Rust/JS
transport was modified by this child, and no end-to-end response acceptance is
claimed from the native serializer or syntax result alone.

## Actual SDK representation fixture correction after c227 (UNRUN repair)

Parent-reported source `4a85b7d6de` integrates the native method8 code and
certificate handoff; its verification harness is `ba3aa7fcee`. The parent's
native and WASM full builds/link steps succeeded. Both owned-boundary runs then
failed inside the additive fixture at `actual SDK result exercises generic
affine representation`. Original four context scenarios passed before it.
The native original job is `0468a83b-07c8-4268-be78-5eb2c26ed777`; its log is
`/home/louistrue/build-workers/worker-state/jobs/0468a83b-07c8-4268-be78-5eb2c26ed777/output.log`.
The child did not run/resubmit any job or modify those receipts.

The test required `prove_generics(*sealed,0)` to find at least one generic face
in a direct box Clip result. That is not a valid SDK representation contract.
The pinned `SmMerge.cpp:7125` copies a surface using `CopyAndAddAnalytics`;
`SmBSplineSurface.cpp:924–989` recognizes planar geometry as `SmPlane` when
analytics are enabled (`SmConfig.h:262`). Boolean surface classes must be
observed independently of the earlier input class and affine conversion path.
The original failure text did not label its caller or dump the count. The
source-local diagnosis identifies the final Boolean fixture by the explicit
generic replacement constructors and by `copy_affine_rational`'s independently
enforced all-generic return invariant for the preceding affine fixtures;
it is not a new case-tagged execution result.

The corrected fixture requires six actual analytic plane faces in this direct
axis-aligned box Boolean result, existing cached-UV method1 admission, no derived
records and v1. It does not relabel geometry, manufacture a UV cache, accept
status7, or waive the Clip success/ownership/topology checks. A new companion
performs the real identity-affine operation on that actual Boolean result,
checks its six analytic source-class counts and then requires **six actual
generic faces, six absent-cache derived records, bit8 and v2**. A subsequent
real Clip consumes that generic affine result and must retain six source proof
records and independent input/output volumes6 and3. Snapshots cover both the
original Boolean source across affine copying and the generic source across
proof and Clip. No conversion is applied to the original source in place.

All original explicit generic replacement and identity/reflected survey affine
fixtures still require six actual generic faces. Their generic helper now
requires all six to execute the missing-cache production proof, rather than
allowing every generic face to pass through cached method2. There is no zero
count/optional generic success path. Fixture labels, actual class counts and
an FNV64 of raw materialized surface/edge coefficients and knots identify the
next source-bound native/WASM failure without sampled geometry. Source ledger
96/102-control cases, seventeenth-record refusal, tolerance contributions and
all malformed-source negatives remain must-pass and are neither skipped nor
weakened. These are the same wired tests on native and WASM.

Parent coordination remains necessary for the separate `plane_tests.cpp`
direct box->Clip->Clip case: that file currently requires the second certificate
to be v2 and invokes a v2-only protocol witness. A direct Boolean chain must
still succeed, but its actual source representation cannot be assumed generic.
The strict v2/protocol companion belongs on actual affine-produced generic
geometry; do not merely drop its proof or accept a refusal. That file and all
parent cutter/copy/context/protocol/runtime/JS/CMake/qualification code were
left untouched by this narrow child correction.

Only the corrected fixture translation unit was syntax-checked against the
immutable SDK headers (C++17, exit0, no diagnostics). No SDK code was linked or
executed here. **Every new/corrected actual SDK/native/WASM/C ABI witness is
UNRUN until parent-admitted execution.** No production proof predicate,
coefficient/record ceiling, tolerance, wire layout or source admission rule was
changed. The restricted theorem's earlier source review is not a blanket claim
about actual Boolean outputs, arbitrary edited graphs, broader affine maps,
paired partition, layers, appearance or whole-product closure.

## Direct-chain certificate distinction and exact endpoint gap (UNRUN follow-up)

After frozen0534 the parent narrowly assigned the direct-chain certificate
expectation in `tests/plane_tests.cpp`. That direct box->Clip->Clip fixture now
requires v1/method1 and no derived records, matching its analytic source rather
than assuming a generic representation. All existing success, original plane,
handle/frame, manifold, closed oriented mesh, volume and release assertions
remain. A separate real `copy_affine(first,I)->Clip` companion requires six
actual derived source records and v2/bit8 and runs the strict existing protocol
witness. Its input/output volumes6 and3, mesh/manifold and independent release
oracles are asserted. The v2 witness was moved to genuinely affine-produced
geometry, not removed or replaced with refusal-as-success.

The parent's actual native Rust run at source4a85 reports a different failure:
`plane_clip.rs:48` returns Kernel7, `edge interval endpoints do not exactly equal
topology vertices`, while consuming the identity-affine copy of the second
Clip. Both earlier Clips, their volumes and the affine copy had succeeded.
World placement is separate runtime metadata: the local plane and native handle
are passed unchanged to opcode20. A world-frame expectation correction cannot
make that native coefficient predicate true.

The restricted gate checks exact real equality of stored finite binary64
coefficients: `q*(b-a)==c0*(b-t)+c1*(t-a)` for both endpoints in all coordinates.
Failure means this source does not supply the exact boundary incidence required
by the reviewed rectangle theorem. It can still satisfy SDK toleranced geometry
validation. `SmMerge.cpp:6670–6820` transports curves/intervals/vertices as
separate representations; `SmStitch.cpp:518–591` obtains floating split params
using a toleranced DropPoint. `TurnToNURBS` and affine class preflight do not
certify exact endpoint incidence. The old log has no scalar dump, so the precise
producer stage/residual magnitude is **unestablished**.

Only bounded failure diagnostics were added at that existing predicate: actual
curve class, endpoint booleans, orientations, selected edge ordinal/coordinate,
homogeneous controls, knots, actual interval and topology vertices, all using
round-trippable17-digit text. The same exact dyadic predicate and status7 refusal
remain. There is no approximation, tolerance easing, cache writing, evaluation,
fitted trim, source repair or new admission method. Frozen0534's strict generic
Clip positive is unchanged and may expose the same genuine gap when executed.

The runtime test's required affine chain must remain an open production gap
until a valid stronger certificate or proved representation-preserving producer
repair closes it. Parent-only proposed Rust expectations/diagnostic hunks and
the detailed source-causal analysis are recorded in the external handoff;
no runtime source was edited. Native/WASM actual execution is still UNRUN for
this correction; only syntax and whitespace checks passed. Exact remains
default/permanent, with broader domains and whole-product closure unclaimed.

## Exact checked identity conversion retaining genuine UV data (candidate, UNRUN)

Parent execution at source26354 (83d15 repair integrated through9018) supplies
an actual scalar witness in original job
`cf149f9a-2efe-4e77-8888-f856b36c3d09/output.log:54324–54344`. Ordinary explicit
and affine generic6 fixtures pass. The direct Clip has six SmPlanes; its
identity-affine copy has six generic surfaces. Both312-value raw fingerprints
are `a1ad985c49c5fec9`. The generic edge has controls
`(0.5,2^-51,0)` and `(0.5,2,0)`, unit/nonrational weights, knots0,0,1,1,
interval0,1, but topology start `(0.5,0,0)`. Its exact initial endpoint residual
is `-2^-51`; the terminal residual is zero. This is a real represented boundary
gap, not a metadata or zero-rounding test artefact. The old strict predicate
is correct to refuse that standalone source-derived rectangle proof.

The fingerprint alone is not byte-identity authority. The pinned
`SmBSplineCurve.cpp:196–234` copy constructor, however, copies existing
materialized coefficients (only knot fixup follows), and
`SmLine.cpp:257–266` delegates to it. `TurnToNURBS` uses that copy rather than
snapping controls to topology. `SmLine.cpp:1631–1686` shows where materialized
line controls can originally be made from floating STEP endpoint evaluation.
The source code and matching fingerprints are consistent with a pre-existing
materialized discrepancy; the log does not dump the analytic input scalar
control itself. It does not identify the first Boolean/analytic-construction
step producing the value, or the actual pre-conversion canonical
origin/axis/scale. The new byte comparison and exact map checks must establish
that stronger claim during execution. Do not assert an invented canonical
frame or blame a particular cancellation without those scalar values.

The new private `IdentityUvTransfer` is an **owned producer** contract, not a
weakened missing-UV admission theorem or an approximate conversion allowance:

1. It is invoked only on the checked owned copy in `copy_affine_rational`,
   before TurnToNURBS and before publication. Only the raw identity matrix can
   activate it, and only when an all-planar, linear represented source actually
   fails exact interval-endpoint-to-vertex equality. Ordinary exact box-affine
   sources keep the original missing-cache method8 positive path. Other source
   classes/nonidentity operations do not gain a transfer or domain credential.
2. It first requires the actual complete existing-UV analytic domain via the
   unchanged non-evaluating admission. Every source plane must have a2x2 unit
   degree1 tensor net, clamped four-knot supports, disabled out-of-bounds flag,
   and independent signed coordinate axes with nonzero finite UV scales.
   Exact dyadic corner equations identify its **actual** analytic UV map with
   the rational tensor map. Source UV hulls and face intervals must lie inside
   that support and actual analytic domain. The generic evaluator's missing
   clamp is not used as a premise.
3. Every3D line is either already generic or has its raw canonical origin,
   signed coordinate axis, scale, finite STEP interval and reverse flag exactly
   identified with both actual materialized knot endpoints. This is the same
   affine-map theorem, not agreement at sampled evaluation results. The SDK's
   near-zero parameter-conversion branch is excluded explicitly. Nonunit or
   mixed weight encodings, curved/higher-degree data and unresolved maps refuse.
   The genuine2D trim maps are similarly checked; all trims must exist,
   materialize, have independent same-face ownership, and have no unresolved
   DropCurveFail provenance that the ownership move would otherwise discard.
4. The private one-shot object holds the **actual existing UV objects** from
   that owned copy. `SetUVTrimCurve(nullptr,0,FALSE)` detaches without deleting;
   `SetOwner(nullptr)` clears their old owner. All proof reads/allocations finish
   before any detach. No trim is fitted, sampled, reconstructed, cloned through
   a base class, or declared present by a Boolean flag. The borrowed input is
   untouched. The pinned setter supports this move explicitly
   (`SmEdgeuse.cpp:4473–4610`); UV owner changes are non-evaluating
   (`SmCurve.cpp:718–735`).
5. The existing TurnToNURBS and both existing transform stages run unchanged.
   Before restoration, an exact word comparison authenticates the same owned
   BRep lifetime, topology inventory, regions/void classification, faceuses,
   shells/material sides, loops, edgeuses/mates/vertexuses, endpoint pointers,
   orientations, vertex coordinates, edge intervals, tolerances, face UV ranges
   and all actual rational coefficients/knots. Only representation class and
   geometry-object identities may change as specified; maps were proved before
   the change and resulting generic maps must use the identical coefficients.
   The original UV objects' dynamic classes, coefficients and canonical fields
   are also checked unchanged. A changed or unsupported state refuses.
6. Each real retained trim is reattached once to its same face/edge/use pair.
   The SDK-selected canonical owner is read back and verified. The unchanged
   generic admission must then succeed through **real existing UV method2**,
   with no derived rectangle records. Thus existing v1/method2 evidence is true
   of the actual consumed object. No method8 record is fabricated for the
   inexact3D endpoint, no credential is accepted from a caller, and no authority
   survives as a pointer cache or persistent ancestry claim. Restored UVs remain
   ordinary owned geometry that later source preflight inspects anew.

This does not snap/fix any3D source point or coefficient. The2^-51 gap may
remain byte-for-byte while the original material UV domain is legitimately
preserved across a proved identical map. If the actual canonical maps do not
agree exactly with their NURBS data, preservation is **not** authorized: new
bounded scalar diagnostics identify that failure, and the required chain stays
open. No new approximate-displacement budget or silently toleranced equivalence
is introduced. The existing affine catch/taint policy still covers failures
inside its owned conversion; original inputs are never edited as a repair.

The token has no external constructor data/bounds/certificate inputs; its only
integration is the fixed owned producer call. It is noncopyable, bound to that
owned BRep reference and complete current object inventory, and consumed once
before its owner can publish. It has at most16 faces,64 edges/vertices/trims,
128 regions,2048 topology objects and32768 exact words per signature; one
cumulative coefficient-read ceiling remains1000000. The unchanged source-domain
ledger still charges present UVs, edges and face controls and expands by every
source/face/edge/vertex tolerance. No wire field, opcode, capability, runtime
parser, parent cutter/copy/context implementation or upstream SDK is modified.

Additional must-pass SDK witnesses require byte-for-byte fixture coefficients,
knots and intervals across the real identity conversion; six actual generic
faces with actual retained UV objects; method2 admission; the original exact
endpoint predicate still refusing that specific independent rectangle proof;
and then a real Clip retaining its6->3 analytical volumes through genuine UVs.
A separate real dyadic box->identity-affine source still requires all six
method8/v2 records and the full existing protocol, mesh, volume, containment,
manifold and lifetime witnesses. Existing explicit generic, survey,96/102 ledger,
record ceilings, tolerance and malformed-source negatives remain. A new real
analytic-line fixture perturbs only its materialized control and must refuse
conversion-map authority **before any UV object is detached**, leaving the
source state unchanged. The parent-owned mesh negative-zero fix is untouched.

All new actual SDK/native/WASM/runtime execution remains **UNRUN**. Syntax-only
checks do not close the required `plane_clip.rs:48` positive, which remains
required/red until parent-admitted execution proves this candidate at the
assembled source. The earlier native/WASM failures and later DNS failure are
preserved as distinct evidence. Exact is default/permanent; no blanket affine,
plane, appearance, paired-partition or layer qualification is claimed.

### R1 correction: finite line-dispatch intermediates (UNRUN)

Independent review of frozen f39 identified a finite-endpoint counterexample:
NURBS support [0,1], STEP ends [-DBL_MAX,DBL_MAX], canonical origin0,
axis+X, scale0.5 and materialized controls [-DBL_MAX/2,DBL_MAX/2]. Both exact
dyadic corner equations pass, but the SDK's STEP span subtraction overflows;
`ConvertTFromNURBSToSTEP(0)` then forms0*infinity and returns NaN. Individual
finite STEP ends do not prove a finite actual parameter dispatch.

Before any detach, line-map preparation now requires a finite positive STEP
span as well as a finite positive non-nearzero natural span. It checks both
endpoint extrema of the SDK's actual subtraction/division/multiplication/addition
sequence, including the reverse branch, for finite intermediates and normalized
ratios in [0,1]. Each stage is monotone over the complete supported natural
interval, so these endpoint extrema bound interior intermediates; these checks
are arithmetic bounds, not sampled SDK evaluations used to infer a domain.
It also checks the subsequent signed-axis position multiplication/addition
extrema for finiteness. The exact dyadic map equations remain separately
mandatory. No approximate identity, tolerance or source repair is introduced.

A new actual SDK malformed-line fixture retains real [0,1] knots and UV objects,
sets the canonical STEP interval and matching materialized controls of the
counterexample, requires the exact corner predicates to pass and actual SDK
conversion to return NaN, then requires the specific nonfinite-STEP-span refusal
with unchanged source coefficients, pointers, UV ownership and metadata. This
fixture is UNRUN until parent-admitted execution. f39 remains preserved; this
is a separate incremental correction, not a newly qualified producer claim.
The endpoint log still proves only the represented gap, not its first producer
or analytic/rational equivalence. TurnToNURBS surface replacement can recreate
UV data and reset domains; exact-seal/restoration reachability, the genuine
method2 positive, separate method8/v2 positive, required Rust line48 chain and
existing status8 cleanup behavior remain held for actual execution.

### R2 correction: bounded analytic evaluation and derivatives (UNRUN)

Independent R2 review supplies a second valid counterexample: natural[0,0.5],
STEP[0,2^1023], origin0, axis+X, scale2^-1023, and unit controls[0,1]. Spans,
position intermediates and exact dyadic corners pass, but `SmLine::Evaluate`
forms Jacobian2^1023/0.5=infinity before multiplying axis*scale*Jacobian. The
actual first derivative is (infinity,NaN,NaN), whereas the rational derivative
is (2,0,0). The finite-position guard alone was insufficient.

The pre-detach line proof now checks that actual Jacobian is finite and positive
and that both the unreversed STEP first derivative and the directed NURBS
first-derivative multiplication stages are finite. A collapsed nonzero-axis
first derivative also refuses. Exact corner predicates remain mandatory.
The bounded analytic-dispatch audit includes the following primary-source paths:

| Pinned SDK path | Checked arithmetic and derivative coverage |
| --- | --- |
| SmLine.cpp404–487, both parameter converters | Both bounded orientation branches; finite positive spans, non-nearzero NURBS span, endpoint extrema of every subtract/divide/multiply/add stage, normalized ratios in[0,1]. Unbounded/near-zero fallback branches remain excluded. |
| SmLine.cpp1035–1147 Evaluate, EvaluateSTEP, EvaluatePoint | Both position multiplication orders, covering mapped NURBS and full STEP intervals; actual Jacobian; unreversed and reversed first derivative stages. Every requested derivative order>=2 is assigned literal zero. Side and nonzero-tangent flags do not alter this implementation. |
| SmCurve.cpp3554–3564 EvaluateSTEPPoint | Delegates to EvaluateSTEP with order0; no independent arithmetic. The STEP endpoint construction used by SmLine::MakeNurb therefore shares the checked position path. |
| SmLine.cpp780–790 EvaluateCurvature | Literal zero, no parameter arithmetic. |
| SmPlane.cpp1458–1585,4371–4381 | EvaluatePoint and Evaluate/EvaluatePointFast use different multiplication grouping; both groupings and both successive additions are checked at full actual analytic-domain corners. All first U/V partial components and the returned stored normal are finite. Higher/mixed partials are literal zeros. |
| SmPlane.h189–200 EvaluateSimple; SmSurface.cpp10950–10999 EvaluateSTEP/STEPPoint | Delegate to the above plane evaluators, with no additional coordinate/Jacobian arithmetic. |
| SmSurface.cpp12242–12289 inherited plane UV converters | Identity copies; no span division or hidden Jacobian. SmPlane declares no override of these converters. |

Finiteness at the complete interval/rectangle extrema bounds each monotone
scalar stage over that domain, using the admitted signed independent coordinate
axes. No SDK evaluation, samples, fitted data or epsilon proves these bounds.
For2D analytic lines the canonical third component must be zero and its
arithmetic is checked too; raw NL_NOZ storage remains non-geometric and is
preserved in the seal. The plane guard checks finite actual canonical domain
ends explicitly; no hypothetical generic evaluator clamp is used.

This coverage concerns valid SDK derivative requests and correctly sized output
storage. In particular plane upper-half requests require U-order<=V-order; the
SDK's unsigned initialization loop is unsafe for the opposite invalid request.
Source geometry cannot authorize malformed request counts/arrays. This patch
does not modify upstream code or claim safety for arbitrary external SDK calls.
Nor does it certify all arithmetic in solvers, projections, normalizing helpers,
quadrature or the generic NURBS evaluator. Finite direct analytic evaluation is
an additional necessary eligibility condition; exact dyadic map identification
is still separate, and no bitwise equality of all floating evaluator outputs
or arbitrary algorithmic success is asserted.

The concrete producer call is still `copy_affine_rational` on the unpublished
checked copy: preparation/proof -> unchanged TurnToNURBS -> both unchanged
transforms -> exact seal -> original UV restoration -> real method2 admission.
TurnToNURBS calls ReplaceSurface with UV recreation enabled; ReplaceSurface
resets the face domain and calls CreateUVTrimCurves, whose paths may evaluate
still-analytic3D lines before the later edge conversion. Restored original2D
SmLines may also be evaluated later. The new guards apply to both dimensions
and all direct derivative orders, without needing an assumed derivative-order
census. Static source inspection establishes these possible routes, not an
actual execution trace or successful seal/restoration reachability.

A new SDK negative constructs the R2 forward source and a real reverse SmLine
using the same reversed materialized basis. It requires the exact corners to
pass, actual analytic order3 calls to expose the nonfinite first derivative
while higher derivatives are zero, a real generic copy to have derivative
(2,0,0), and the STEP call to retain its finite first derivative. The production
preparation must then refuse specifically at its Jacobian guard before any
UV detach; coefficient/knot/interval/pointer/metadata snapshots and actual UV
owners must remain unchanged. All these numerical assertions are UNRUN.

Frozen f39 and8cdb remain unchanged. Method2 positive, separate genuine six-record
method8/v2 positive, original Rust plane_clip.rs48 chain, exact-seal/restoration
reachability and status8 cleanup qualification remain held for parent actual
execution. The first producer of the observed2^-51 endpoint gap remains unproven.
No original oracle, tolerance, source predicate, public protocol, opcode, SDK,
copy/context implementation, CMake or runtime source is changed by R2.
