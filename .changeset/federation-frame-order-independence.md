---
"@ifc-lite/geometry": minor
"@ifc-lite/viewer": patch
---

A federation no longer renders a different scene depending on which model loaded first. Previously, loading a small-coordinate model (no RTC offset) before a large-coordinate one left the small model in the raw frame while the large model used its own anchor, and `federationFrameInfo` reported a frame the large model was not drawn in. Now, after every federated load settles, the viewer converges every loaded model onto one anchor: the earliest-loaded model with a `wasmRtcOffset`. It reads the final set of loaded models, so loads that overlap and finish in either order end in the same scene. `federationFrameInfo` applies the same rule, so a near-origin model or a raw point cloud loaded first no longer defines the reported frame.

The new `@ifc-lite/geometry/rtc-rebase` module (`convergeGeometryOntoRtcAnchor`) moves a model by translating each mesh's double-precision `origin` and its `coordinateInfo` (`wasmRtcOffset`, `wasmRtcFrame`, `originalBounds`, `shiftedBounds`). The float32 vertex `positions` never change, so millimetre detail survives map-coordinate anchors, where one float32 step is 0.25 to 0.5 m. The absolute-world `geometryAabb` and `localToWorld` fields are RTC-invariant and are left alone. The viewer withdraws a moved model's spatial index before rebuilding it.

Point clouds are never moved, because they never join the RTC frame. A model with GPU-instanced geometry cannot be moved after load: the viewer names it in a warning and still converges every other model.
