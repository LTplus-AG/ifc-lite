---
"@ifc-lite/viewer": patch
---

Fix inward-facing normals on the "add element" instant-preview mesh's side faces.

`buildBoxFromIfcCorners` draws the instant-preview box the moment a builder tool commits, and is fed by two callers that wind their corner rings in **opposite** directions: `buildAxisBox` (column / door / window) lists its bottom ring counter-clockwise seen from IFC +Z, `buildLinearBox` (wall / beam / member) lists it clockwise. Each side face's normal came from `faceNormal(corners, a, b, c)`, whose sign follows that winding — so one fixed argument order was outward for one family and inward for the other. Columns, doors and windows previewed with all 4 side faces lit backwards until the export+re-parse round-trip replaced the preview with real geometry.

Fixed by resolving the side normal's sign against the box centre rather than against the ring order: the cross product still supplies the face's axis, and the direction that points away from the centre is chosen (valid for any winding, since the box is convex). Both families now light correctly, and a future caller gets outward normals whatever ring order it uses. Vertex positions, the index buffer, per-vertex entity ids and the hardcoded top/bottom normals are byte-identical to before for every currently reachable shape.
