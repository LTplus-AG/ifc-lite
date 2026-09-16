---
"@ifc-lite/bcf": minor
"@ifc-lite/clash": minor
"@ifc-lite/viewer": patch
---

BCF viewpoints are now written and read in IFC world coordinates (#4806). The viewer captured the camera, section plane and clash/IDS framing cameras in its origin-shifted render frame, so for a georeferenced model BIMcollab, usBIM and other BCF tools put the camera kilometres from the building, and imported cameras landed off-model the same way. `@ifc-lite/bcf` adds `translateViewpoint`, and `createBCFFromClashResult` accepts a `worldOffset`. Viewpoints written by earlier ifc-lite versions still open in place. Topics and viewpoints captured from the BCF panel while a clash is focused now carry the clashing pair as found objects and colouring, and the Clash panel's topic records its source-file header.
