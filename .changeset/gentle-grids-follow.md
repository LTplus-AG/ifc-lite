---
"@ifc-lite/viewer": major
---

Viewer position and rotation edits refuse grid-relative placement chains instead of presenting child-local coordinates as directly editable storey coordinates. These newly enforced refusals change the public runtime validation contract.

Bind actual Column-tool grid-intersection snaps to persistent IfcGridPlacement graphs through the shared create API. The linear snapping consumer revalidates the crossing, native units, height and section heading atomically; Undo/Redo records the entire graph. Alt bypass and ordinary edge snaps retain local placement.

Bound columns share ordinary authored geometry completion, including initial parameter fallback when native remeshing declines and revealing the occurrence from Types view. Subsequent grid movement updates live geometry through native remeshing; the initial fallback is not a grid-movement substitute.
