---
"@ifc-lite/viewer": patch
---

File > Export > GLB now exports the model as edited in this session. A Start blank session with authored elements used to fail with "GLB export produced 0 meshes", and a loaded model silently lost the elements it authored and kept the ones it deleted, because the export re-meshed the file as it was loaded. It now re-meshes the same edited bytes the IFC and USD exports use.
