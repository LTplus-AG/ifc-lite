---
'@ifc-lite/geometry': patch
---

A self-referential `IfcTrimmedCurve` no longer aborts the process.
`sample_curve_polyline` followed `IfcTrimmedCurve.BasisCurve` recursively, and
that reference comes from the file, so one entity naming itself as its own
basis overflowed the stack — an abort rather than a catchable panic, so nothing
downstream could turn it into a load error. The sampler is reached by any
`IfcAdvancedBrep` with a composite edge curve and by the surface-of-revolution
generator profile, so ordinary geometry paths were exposed.

Two guards now, because they bound different things: a visited set stops cycles
and fan-out, and `MAX_BASIS_CURVE_DEPTH = 32` stops a long acyclic chain, where
every id is distinct so the set never fires and the recursion aborts on stack
depth alone. Real trimming nests one or two levels.

At either bound the sampler returns an empty polyline rather than an error, so
the offending curve contributes no points and the edge or face built from it is
missing from the mesh. Legitimate trimmed-on-trimmed chains ending at a real
curve are still sampled in full.
