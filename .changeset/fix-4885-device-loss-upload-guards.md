---
"@ifc-lite/renderer": patch
---

Every GPU upload path outside `render()`'s own device-loss containment — `Renderer.addMeshes`, `loadGeometry`, `addMesh`, `ensureMeshResources`, `createMeshFromData` — now gates on `isDeviceLost()` through one guarded helper before touching the device, and classifies a mapped-`createBuffer` `RangeError` caught mid-call as device-loss fallout (not host memory pressure) when the loss latched during that call. These methods return a typed outcome instead of throwing when the device is already lost; existing callers that ignored the previous `void` return are unaffected. The viewer's `setSpaceOverlayMeshes` (Space Sketch draft ghosts) is now routed through the same containment the streaming path already had, and a `createBuffer failed` load error gets its own `gpu_alloc_failed` bucket (tagged `device_lost_at_time` when known) instead of being folded into `out_of_memory` (#4885).
