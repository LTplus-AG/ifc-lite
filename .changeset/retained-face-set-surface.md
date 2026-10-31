---
"@ifc-lite/wasm": minor
"@ifc-lite/cli": minor
---

Retained face sets now publish their `IfcIndexedColourMap` and `IfcIndexedTriangleTextureMap`, also through a cut. A published part carries `palette` (one entry per triangle) and `texture` (source UVs, six per triangle), each taken from the source row its persistent face key names; a new vertex at a cut interpolates its row's authored UVs. The retained viewer splits one mesh per palette colour and textures with exact's V-flipped UVs. A map exact had to repair, an unreadable row, or a texture on an `IfcPolygonalFaceSet` refuses `appearance_unsupported`; nothing publishes as a plain colour in their place. The default exact engine and default wasm are unchanged.
