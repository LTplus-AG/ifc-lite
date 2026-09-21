---
"@ifc-lite/renderer": minor
---

Add the renderer-owned relative-to-eye precision contract used to migrate all
GPU and CPU coordinate paths safely to large georeferenced source frames.
Use the shared frame for CPU camera projection and perspective picking rays,
preserve non-throwing malformed-pose behavior, and isolate matrix ownership.
