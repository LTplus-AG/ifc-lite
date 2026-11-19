---
"@ifc-lite/export": minor
"@ifc-lite/viewer": patch
---

`MergedExporter` is also published as `@ifc-lite/export/merged-exporter`, and the package declares `"sideEffects": false`, so a bundler can leave the merged STEP export out of a startup bundle. The viewer loads it only when a merged export runs, which takes it off the viewer's eager JavaScript.
