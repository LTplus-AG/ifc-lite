---
'@ifc-lite/geometry': patch
---

Composite-curve profiles on `IfcSurfaceOfLinearExtrusion` produce geometry
again, and can no longer abort the process.

The silent half: `extract_composite_curve_points` handed each segment's
`ParentCurve` id to the profile dispatcher, which reads attribute 2 as "the
profile's curve". An `IfcPolyline` has no attribute 2, so every segment
errored, the caller swallowed it, and the function returned an empty point set
as `Ok` — indistinguishable from a legitimately empty profile. Every
`IfcSurfaceOfLinearExtrusion` with a composite-curve profile lost its geometry
this way. Curve dispatch is now separate from profile dispatch, so a
`ParentCurve` is sampled as the curve it is. Two further defects that only
became observable once points started flowing are fixed with it:
`IfcCompositeCurveSegment.SameSense = .F.` now reverses the segment as the
schema requires, and the joint point between segments is dropped only when it
actually coincides, so a `.DISCONTINUOUS.` joint or a real gap keeps the point
it used to lose.

The fatal half: a composite curve whose segment's `ParentCurve` is that same
composite curve re-entered the sampler and overflowed the stack — an abort, not
a catchable panic. Three bounds now travel together, each blind to what the
others catch: a path-scoped visited set for cycles, a nesting cap of 32 for a
long acyclic chain where every insert succeeds, and a budget of 100,000 curve
visits for an acyclic DAG that doubles its work per level while nothing is
cyclic and nothing exceeds the depth cap.

The two kinds of bound behave differently, deliberately. A cycle or the depth
cap yields no points for that nested curve and reports nothing. Budget
exhaustion returns a catchable error (`Curve traversal exceeded 100000 nested
curves`) rather than a truncated point list, because a short profile returned
as if it were complete is a wrong shape; the element is dropped instead.
