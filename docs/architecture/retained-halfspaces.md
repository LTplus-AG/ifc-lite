# Retained bounded and boxed halfspaces

M6 (#7955) runs only with the opt-in retained runtime. Exact remains unchanged.
An `IfcPolygonalBoundedHalfSpace` removes the intersection of its plane material
and the infinite prism along `Position.Z` through `PolygonalBoundary`. The
retained path represents that intersection with one derived CUT-0 prism and one
Difference. Its far cap is padded beyond the conservative host bounds; its base
and lateral faces remain on the authored surfaces.

Line boundaries, including simple non-convex loops, retain their ordered edges.
Circular arcs use wire-format-1 kind 3 and are admitted only when the cut plane
is perpendicular to the prism axis. A cut plane parallel to the prism axis
and boundaries with more than 256 vertices refuse the product. Source validation precedes the kept-side
bounds proof. No exact heuristic, unbounded fallback, or exact retry participates.

`IfcBoxedHalfSpace.Enclosure` is only a computation hint and is never read.
Boxed halfspaces delegate to the plain-plane implementation, including its
refusals. A successful boxed twin must have an
identical cutter payload and bit-identical measured volume.

## Qualification sequence

M5 (plane halfspaces and chained clips) is on main, so M6 is qualified against
it: boxed halfspaces and their plain-plane twin publish with bit-identical
cutters and volumes, and PBHS → plane → solid Difference chains compose in node
order. A consumed (fully removed) host reports `empty_result` at M5's shared
`halfspace_clip` site with cause `consumed`; M6 adds no competing hook. The
2026-10-27 user decision applies: the synthetic `f-f-halfspaces` fixture plus
its bit-identical plain-plane twin is sufficient release qualification for
boxed halfspaces (no committed or heavy-corpus model has one).

The source oracle independently decodes planes and boundary placements. Linear
non-convex loops are ear-partitioned; inclusion–exclusion integrates triangle
prism intersections through CUT-0's section oracle, bounded to 4,096 evaluations.
Distant source partitions are discarded only after a zero-volume intersection
proof against the host, spending the same budget; this also qualifies the
longer #960 chains. A work-cap or unsupported oracle family is an explicit
missing section result, not zero. Original boundaries, including analytic arcs, define the gated
strict-interior removed-material check; triangulation seams do not.
For a single curved boundary, the oracle reverses the section operands and
integrates its analytic prism against the linear host partition. Circular cuts
therefore have a removed-volume authority even when wholly inside the host.
Unavailable curved or combined curved/opening volumes fail the comparison gate;
an opening-only volume is never substituted for a combined result.
Synthetic hand integrals additionally qualify the quarter-circle case. Their
fixture passed independent adversarial Opus review and IFC4 schema/round-trip
validation on 2026-10-28. Measured evidence is stored outside the
repository under the implementation's M6 evidence directory.

FZK walls #60012 and #67828 each have two PBHS clips, no plain-plane clip, and
one opening with two extrusion parts. Their +2 target therefore does not depend
on M5. Coverage manifests are updated only from an executed comparison run.

The arc fixture wraps its `IfcIndexedPolyCurve` in an `IfcCompositeCurve`, since
IFC4's PBHS `BoundaryType` rule permits only `IfcPolyline` or `IfcCompositeCurve`.
This corrects §7.1(f)'s direct-indexed fixture spelling while retaining the
`IfcArcIndex` and the prescribed geometry.

For source polylines, section area is quadratic between topology events, so
Gauss–Legendre quadrature evaluates each span directly. Curved sections retain
the shared adaptive integration. Shared, oppositely directed opening end caps
prove zero-volume intersections before triangle tuple expansion; this avoids
spending the fixed work budget on disjoint FZK opening parts. Neither change
alters the preregistered acceptance tolerances or the 4,096-section cap.

The synthetic fixture is registered in the committed universe and M6 coverage
fragment. Its consumed, mixed-chain and plain-plane cases run unconditionally.
Four existing coverage rows change from `operation_unsupported` to published:
the two FZK walls and mapped PBHS products #173/#231 in `f-e-mapped-booleans`.
The new fragment has twelve published rows and four typed refusals.

Persistent face attribution uses the authored plane and boundary walls; the
artificial far cap never gains an IFC source identity. The independent normal
oracle reads those same surfaces from IFC source, including boxed planes,
circular walls, Boolean polarity and mapped frames. It never uses the retained
cutter or output normals as its expected direction. Clipped products retain
appearance and face provenance and remain excluded from instancing. The affine
interaction witness mirrors and nonuniformly scales a boxed result, checking
positive signed volume, its authored centroid and executed-clip lineage.

The equivalent-boundary regression fixture is generated with `step.Model` by
`generate-halfspace-boundaries.py`: explicit and omitted indexed segments,
trimmed lines, and parameter/Cartesian circle trims agree in publication,
clearance and source normals. Required native CI downloads FZK and #960 before
running witnesses and makes missing fixtures fatal. Every published #960
product must have a source volume authority. Mapped PBHS products enter the
same checks with their mapping frames applied.
