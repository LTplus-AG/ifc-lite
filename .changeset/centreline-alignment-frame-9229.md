---
'@ifc-lite/viewer': patch
---

Selected centreline: the curves stay on the meshes when you pin another federation anchor and don't re-align yet. A rebuild during that time, for example after re-selecting, used to draw them in the pinned anchor's frame while the meshes stayed in the old one. Each aligned model now records the frame it was aligned into, and a re-align moves the curves with the meshes. An element you edit in that model during that time is re-meshed into the same frame, instead of jumping to the pinned anchor's. Loading, streaming, reordering or removing a model that holds none of the selection no longer clears the curves, so a Measure Point reading on them stays Live. In single-file mode, a new geometry result now re-places the curves instead of leaving the old ones drawn.
