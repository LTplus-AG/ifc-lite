---
"@ifc-lite/renderer": minor
---

Clip against more than one cutting plane (#7545). `RenderOptions.extraSectionPlanes` takes up to seven `SectionPlane`s beyond `sectionPlane`, each resolved by the same code as the primary plane (cardinal slider range, building rotation, explicit normal), and a fragment is kept only where every plane keeps it. The mesh, selection-outline, shadow, point-cloud, GPU-pick and CPU-raycast paths all clip against the same resolved list, and a single plane renders exactly as before.
