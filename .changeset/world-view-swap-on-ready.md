---
"@ifc-lite/viewer": patch
---

3D World Context no longer blinks out while it rebuilds.

The world view dropped its model the moment anything invalidated it — a streaming geometry batch, a type toggle, a georef edit, a hide — and only then started a one-second debounce, a GLB build and a glTF load. The building disappeared from the map for over a second on every edit, which reads as the model being broken rather than reloading.

The model now stays on the globe while its replacement is built, and the two are exchanged only once the new one can actually draw. That last part matters: `Model.fromGltfAsync` resolving means the glTF was fetched and parsed, not that the model is renderable — Cesium creates its WebGL resources across later frames and skips one more frame after raising `readyEvent`. Swapping at construction time would have replaced a drawable primitive with a blank one and left the map empty for several frames, a much shorter version of the same defect. The effect cleanup only cancels the in-flight build; the model is torn down when its geometry goes away, or with the viewer.

A rebuild no longer flips `cesiumGlbLoaded` false and back, so the solar study — which relied on that flip to re-apply shadow settings to the new primitive — now keys on a model epoch that changes whenever a different primitive reaches the globe.
