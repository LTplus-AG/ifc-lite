---
"@ifc-lite/sdk": minor
"@ifc-lite/bcf": minor
---

Several cutting planes through BCF and the SDK (#7545). `createViewpoint({ sectionPlanes })` writes one `ClippingPlanes` entry per enabled plane and `extractViewpointState` returns them all as `sectionPlanes` (the first still as `sectionPlane`). `bim.viewer` gains `getSections()`, `setSections()`, `addSection()` and `removeSection(id)`; a backend that clips with a single plane keeps working (the new methods are optional on `ViewerBackendMethods` and fall back to `getSection` / `setSection`). `bim.bcf.createViewpoint` and `extractViewpointState` take and return `sectionPlanes` too.
