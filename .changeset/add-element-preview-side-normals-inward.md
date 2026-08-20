---
"@ifc-lite/viewer": patch
---

Fix inward-facing normals on the "add element" instant-preview mesh's side faces.

`buildBoxFromIfcCorners` (used for the wall / beam / member / column / door / window instant-preview meshes drawn the moment a builder tool commits) computed each side face's normal as `faceNormal(corners, a, b, d)` — e.g. `faceNormal(ifcCorners, 0, 4, 1)` for the quad `[0, 4, 5, 1]` — which evaluates `cross(corners[b]-corners[a], corners[d]-corners[a])`. That pointed inward on all 4 side faces of every such box, so a freshly authored wall or column previewed lit backwards until the export+re-parse round-trip replaced the preview with real geometry. Top and bottom faces were unaffected (their normals are hardcoded, not derived from corner winding).

Fixed by swapping the last two arguments (`faceNormal(a, b, d)` → `faceNormal(a, d, b)`), which negates the cross product (`cross(v, u) = -cross(u, v)`) and produces the correct outward normal. The `corners:` arrays that drive vertex order and triangulation are untouched.
