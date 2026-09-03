---
'@ifc-lite/viewer': minor
---

The Properties panel now shows a "Part of Assembly" badge when the selected element is aggregated into an `IfcElementAssembly`, and clicking it selects that assembly (#3620).

An assembly owns no mesh of its own, so selecting it highlights its renderable parts with the assembly kept as the primary selection, rather than framing the camera on something the renderer then leaves unlit.
