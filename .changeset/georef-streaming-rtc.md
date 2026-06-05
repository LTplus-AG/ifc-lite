---
"@ifc-lite/wasm": patch
---

Geometry: fix ~0.5 m vertex jitter on georeferenced models (#948). When a model's world offset lives in spatial-structure placements emitted late in the file (e.g. a Revit/French export with `IfcSite` at the end), `buildPrePassStreaming` detected the RTC offset from the partial index built up to the first ~50 geometry jobs, missed the offset, and the ~8×10⁶ m coordinates were cast to f32 (~0.5 m grid) before reaching the GPU. The streaming pre-pass now re-detects against a full index when the partial pass finds no offset and the `IfcSite` has not yet been scanned, so vertices are shifted local before the f32 cast. Gated so origin-local / early-site models do not pay for a second index build.
