---
"@ifc-lite/renderer": patch
---

The selection and hover outline for GPU-instanced occurrences no longer throws when the camera is more than 1,000 km from the world origin (#6400). The instanced mask draw packed a stand-in drawable origin of `[0, 0, 0]`, which was validated against the camera-relative envelope. `vs_instanced` never reads that origin; each occurrence's origin comes from its per-instance delta, as in the instanced colour pass. The mask uniform now carries only the frame fields: view-projection, section plane, clip box and flags. Hover copies and selected meshes pack exactly as before.
