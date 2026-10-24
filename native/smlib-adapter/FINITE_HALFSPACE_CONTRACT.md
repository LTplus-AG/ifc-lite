<!-- SPDX-License-Identifier: MPL-2.0 -->
# Finite halfspace lowering checkpoint (#7955)

This is disabled, unqualified implementation infrastructure. Exact remains the
default. No final retained product, activation, SDK qualification, native
`tessellation` hold clearance, or full J1 completion is claimed here.

## Source and operation contract

The shared retained Boolean controller captures `IfcPolygonalBoundedHalfSpace`
and `IfcBoxedHalfSpace` before admitting any component operation. The former
owns `Position`, the explicitly closed 2D polyline, or a straight indexed curve's
complete coordinate list, ordered line indices and `SelfIntersect`. The latter
owns `Enclosure`, its corner and three strictly positive dimensions. Box axes
are in `BaseSurface.Position`; polygon axes are in their separate `Position`.
Raw location/direction values, ids, omitted axes, authored `AgreementFlag`, unit
scale, Boolean id, source epoch/revision and occurrence remain distinguishable.

The coordinate convention follows the buildingSMART definitions:
[polygon](https://standards.buildingsmart.org/IFC/RELEASE/IFC2x3/TC1/HTML/ifcgeometricmodelresource/lexical/ifcpolygonalboundedhalfspace.htm),
[box](https://standards.buildingsmart.org/IFC/RELEASE/IFC2x3/TC1/HTML/ifcgeometricmodelresource/lexical/ifcboxedhalfspace.htm).
The polygon's extrusion is unbounded in its Position Z direction; its overlap
with the existing finite host is realized without an invented extrusion depth.

For host H and each convex boundary cell C_i, the shared program constructs
H intersect BaseSurfaceHalfspace intersect C_i by existing sealed plane clips.
Intersection unions those finite pieces. Difference subtracts those pieces
from H in order. Convex rings stay whole. Concave simple rings are decomposed
with exact orientation and closed-segment predicates and an ear partition,
without moving any point or imposing a convexity restriction. Each side wall
uses an inward normal independently of the base surface AgreementFlag. Box
cells use six inward planes. No giant mesh cutter, sampled boundary, epsilon
expansion or exact-engine retry is introduced.

Each component has a distinct logical output. Only the last component resumes
the enclosing Boolean continuation. Source validation and plan allocation
finish before the first component is admitted; later execution failure still
refuses the whole product. Every component uses existing native/browser owner,
source, input/frame/plane-bit, Empty, operation identity and lease validators.
The immutable boundary source and component role remain on the issued logical
plane. This does not invent a new SDK certificate or claim persistent IFC face
identity. The adapter ABI, coefficient/domain seals, affine/lineage validators,
and all earlier plane/owned-domain guards are unchanged.

## Predeclared independent oracles

`rust/testkit/src/retained_finite_clip.rs` defines source STEP and independent
areas, first moments and bounds. Host is [-1,1] x [-2,2] x [0,3], volume24.
Intersection volumes are2 (rectangle/indexed/placed rectangle),1.5 (concave L),
0.25 (box and the same physical box in millimetres), and0.125 (rotated box,
false AgreementFlag). Difference complements the first five within the same
host. Expected bounds and centroids are explicit constants/first-moment
formulas, never obtained from the operation graph or SDK output.

Native and actual module Worker tests both require absolute volume, extrema
and centroid errors at most1e-6, chord0.001m, angle5 degrees; native volume query
precision1e-8. These limits were selected before execution and are unchanged
from the existing plane witness. Native additionally rechecks the original
host's volume24. Source tests independently evaluate membership of the actual
issued graph at points chosen off authored boundaries. This tests set algebra,
placement and units; it is not a numerical BRep qualification.

Native negative definitions cover base-receipt replay, identical geometry from
a foreign worker, expiry between components and false Empty reports. Existing
retirement/resource/affine/lineage/clip tests remain intact. The independently
invoked CI mutation runner omits boundary planes, discards box corner, doubles
box dimensions, discards units, loses concavity and reuses the base agreement
for side walls. It requires green controls, the specific membership assertion
failure and restored controls. Compilation failures/timeouts are not kills.

## Explicit remaining full scope and execution prerequisites

All Rust, SDK, actual Worker and mutation execution is UNRUN at this checkpoint.
Parent owns admission. Native and Worker positives must execute rather than
skip, and all existing observers/protected cases must remain green. No skipped
SDK/fixture test constitutes acceptance. Performance/memory and exact-default
identity remain to be measured on the parent's admitted integrated commit.

The source support is broader than a convex box, but is not full IFC boundary
support. Composite curves, circular arcs (including indexed ArcIndex), holes,
collinear/repeated edges, touching/self-crossing rings, non-plane base surfaces,
and Union with a finite enclosure are explicitly refused. These remain release
requirements where valid IFC permits them; this document does not defer them.
The source polygon limit is256 vertices; coordinate magnitudes over1e100 refuse
to protect adaptive predicates. Generated operations are capped at128; the
existing runtime combined ancestry limit also applies and can refuse sooner.

SDK numerical reach is stricter than this source algebra. In particular,
`src/plane_source_domain.cpp::axis_inventory` requires one outer loop, four
complete edgeuses and independent coordinate axes for its owned generic affine
surface proof. Arbitrary oblique cuts, nonrectangular reconstructed UV domains,
curved chains and near-tangent geometry need their own valid domain proofs;
none of these checks is relaxed here. A numerical refusal on one of the new
positive definitions is a blocker, not an acceptable bounded-success result.
The exact future prerequisite is a sound owned-domain certificate for those
actual resulting trimmed surfaces, followed by positive numerical evidence.

The authored House extract remains at manifest path
`issues/960_house_segmented_roof_clip.ifc`, SHA256
`09cea73157338088f0fb1d2b5d341e45e4b91f4f0035adcf8c45e73f5434238f`.
It is absent in the implementation checkout but was read from the registered
root checkout and verified against that SHA256. The source-only authored test
pins wall2152's first boundary1938: base surface1928, boundary placement1932,
polyline1937, points1933..1936, false agreement and millimetre units. It does not
claim completion of the entire authored chain. Its established exact regression
and source oracle are `rust/geometry/tests/issue_960_segmented_roof_clip.rs`;
that historical oracle does not qualify this retained implementation. Parent
must fetch and establish retained native/Worker evidence on it; inline analytic
fixtures above are not labelled as authored application output.
