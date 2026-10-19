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
