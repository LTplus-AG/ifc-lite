---
"@ifc-lite/renderer": minor
---

Add the renderer-owned relative-to-eye precision contract used to migrate all
GPU and CPU coordinate paths safely to large georeferenced source frames.
Use the shared frame for CPU camera projection and perspective picking rays,
preserve non-throwing malformed-pose behavior, and isolate matrix ownership.
Instanced colour, picker and shadow submissions now share CPU f64
drawable-minus-camera packing, and line overlays spatially batch compact
segments while supporting bounded disjoint partition submissions.
