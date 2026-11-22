---
"@ifc-lite/viewer": patch
---

Type visibility (spaces, openings and the other class toggles, the Model/Types switch and the analytical/physical modes) now hides entities on the GPU instead of re-uploading the scene. Every mesh is uploaded once, including the classes hidden by default, and a toggle only changes which ids the viewport hides (#10264).
