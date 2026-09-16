---
"@ifc-lite/geometry": minor
"@ifc-lite/bcf": minor
"@ifc-lite/sdk": minor
"@ifc-lite/clash": patch
"@ifc-lite/cli": patch
"@ifc-lite/viewer": patch
---

BCF viewpoints are written in IFC world coordinates outside the viewer too (#4879). `ifc-lite clash --bcf`, the MCP playground's `clash_bcf_export` and `bim.bcf.createViewpoint({ camera: bim.viewer.getCamera() })` wrote render-frame (origin-shifted, RTC-local) cameras, so other BCF tools put the camera hundreds of kilometres from a georeferenced building. A new `@ifc-lite/geometry/world-frame` entry point holds the one render frame <-> world conversion (`renderFrameWorldOffset`, `totalYupOffset`, `ifcToViewerAxes`, `viewerToIfcAxes`, `federationFrameInfo`), which the viewer, CLI, playground and SDK all use. `@ifc-lite/bcf` adds `viewpointFromWorld`, the inverse of `translateViewpoint` that keeps viewpoints written by ifc-lite before #4806 in place. In the SDK, `ViewerBackendMethods` gains an optional `getRenderFrameOffset()`; when a backend provides it (the viewer does), `bim.bcf.createViewpoint()` adds it and `bim.bcf.extractViewpointState()` subtracts it, so viewpoints are world coordinates and extracted cameras are ready for `bim.viewer.setCamera()`. Backends without it, and `new BCFNamespace()` with no backend, behave as before.
