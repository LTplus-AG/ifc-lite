---
"@ifc-lite/viewer": patch
---

Appearance editing works on models loaded with `?compactGeom`. A compact mesh carries no canonical corner provenance (its records decode re-welded on a lattice), so once an appearance plan names the products it binds, those whose meshes lack it are re-meshed exactly from the model's source, with the mesher the load uses, and the preview binds after the 3D view draws them. Scan-to-IFC transfer onto compact meshes is not covered yet.
