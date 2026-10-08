---
"@ifc-lite/create": major
---

Validate persisted grid intersections against one live owning grid before emitting IFC records. File-backed axes now require the paired source store read context as the fourth argument to gridIntersectionPlacement; mixed or ambiguous grid owners, same-row axes, deleted axes, and invalid grid placement references refuse. Generic emission preserves valid curved and radial axes. Overlay-only grids remain supported without a source context.

Add addColumnOnGridToStore to emit columns bound to persistent IfcGridPlacement graphs. The linear binding consumer revalidates the crossing, native units, height and section heading atomically before emitting the whole graph.
