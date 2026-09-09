---
"@ifc-lite/viewer": patch
---

A reload now regenerates the section cut that a restored `SectionConfig` describes, instead of loading it into a value nothing consumed. Previously the restored 2D drawing markup (measurements, annotations) came back floating over whichever plane the section slice already held; `useDrawingGeneration` now converts the restored `SectionConfig` back into the store's `sectionPlane` and lets the existing plane-changed path regenerate the drawing, so markup returns with its own cut.
