# Retained bounded and boxed halfspaces

M6 (#7955) runs only with the opt-in retained runtime. Exact remains unchanged.
An `IfcPolygonalBoundedHalfSpace` removes the intersection of its plane material
and the infinite prism along `Position.Z` through `PolygonalBoundary`. The
retained path represents that intersection with one derived CUT-0 prism and one
Difference. Its far cap is padded beyond the conservative host bounds; its base
and lateral faces remain on the authored surfaces.

Line boundaries, including simple non-convex loops, retain their ordered edges.
Circular arcs use wire-format-1 kind 3 and are admitted only when the cut plane
is perpendicular to the prism axis. Parallel axes and boundaries with more than
256 vertices refuse the product. Source validation precedes the kept-side
bounds proof. No exact heuristic, unbounded fallback, or exact retry participates.

`IfcBoxedHalfSpace.Enclosure` is only a computation hint and is never read.
Boxed halfspaces delegate to the plain-plane implementation, including its
refusals and eventual M5 qualification. A successful boxed twin must have an
identical cutter payload and bit-identical measured volume.

## Qualification sequence

The **2026-10-28 Round 2 implementation/orchestrator message** explicitly revises
M6 §1/§8: M5 is a qualification dependency, not an implementation dependency.
On CUT-0, bounded-only clips qualify independently. Boxed/plain-plane twins
prove identical outcomes, currently both `operation_unsupported`.

The unconditional tests named `qualifies_after_m5` assert the final publication
contract for boxed twins, PBHS → plane → solid Difference, and consumed-result
provenance. They are explicitly excluded from Round 2 passing counts and are
run after the M5 rebase. They are not `#[ignore]` tests. M5 owns the shared
Boolean completion/provenance hook; M6 adds no competing hook.
The consumed expectation uses M5's `halfspace_clip` site, following that shared
hook ruling in place of M6's earlier `bounded_halfspace` spelling.

The source oracle independently decodes planes and boundary placements. Linear
non-convex loops are ear-partitioned; inclusion–exclusion integrates triangle
prism intersections through CUT-0's section oracle, bounded to 4,096 evaluations.
A work-cap or unsupported oracle family is an explicit missing section result,
not zero. Original boundaries, including analytic arcs, define the gated
strict-interior removed-material check; triangulation seams do not.
Synthetic hand integrals additionally qualify the quarter-circle case. Their
fixture passed independent adversarial Opus review and IFC4 schema/round-trip
validation on 2026-10-28; its M5 cases still await qualification. Measured evidence is stored outside the
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

The synthetic universe/coverage fragment is a post-M5 qualification step: its
consumed and plain-plane cases must satisfy their unconditional expectations
before the complete fixture can enter the committed coverage gate. This round
uses individually asserted SDK outcomes for the bounded-only and twin cases.
