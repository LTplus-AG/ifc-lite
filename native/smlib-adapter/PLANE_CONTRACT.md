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
- **4, bounded analytic cylinder:** Exact dynamic type `SmCylinder`, live
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
