---
"@ifc-lite/viewer": patch
---

2D Section panel: a new cut plane (such as a face pick) is fitted even with Pin on, a regenerated drawing that lands entirely outside the current view is fitted, and resizing the panel keeps the drawing centred. Previously the old transform was reused and the drawing showed cropped or off-panel (#5392).
