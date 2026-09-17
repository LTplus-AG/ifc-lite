---
"@ifc-lite/geometry": minor
"@ifc-lite/viewer": patch
---

A federation of two models no longer renders a different scene depending on which one loaded first. Previously, loading a small-coordinate model (no RTC offset) before a large-coordinate one left the small model in the raw frame forever, while the large model picked its own anchor unshared — the two overlapped in the render frame, and `federationFrameInfo` reported a frame neither model was actually drawn in. Now the federation loader converges on the SAME anchor regardless of load order: a model that introduces the federation's first real RTC anchor causes every already-loaded, still-raw model to be re-based onto it (`@ifc-lite/geometry`'s new `rtc-rebase` module), and `chooseSharedRtcOffset` gives every later model that same anchor. `federationFrameInfo` now always reports the frame actually applied to every model in the federation.

One case is refused rather than re-based: when an already-loaded model carries GPU-instanced geometry, whose per-occurrence transforms live in renderer-owned instance buffers that nothing reachable from a `GeometryResult` can move. Re-basing its meshes alone would split one model across two coordinate frames, so the whole federation keeps its original frames and the viewer says so, naming the fix (load the georeferenced model first).
