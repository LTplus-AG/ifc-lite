---
"@ifc-lite/clash": patch
"@ifc-lite/wasm": patch
---

Clash depths between rotated boxes no longer drift with the model's distance from the origin.

Box recognition, which lets the engine report an exact box-to-box penetration depth labelled as measured, rebuilt each box's centre from absolute world coordinates along axes taken from a single triangle each. Any error in those axes was multiplied by the element's distance from the origin. A 20 mm overlap between a 50 mm curtain-wall panel and a mullion, both rotated, read 23 mm (30 mm for a three-axis rotation) 123 m from the origin. From 1 km out it fell back to the AABB estimate (0.25 m / 1.38 m), and 10 km out the panel was not recognised as a box at all.

Recognition now measures from a point on the element instead of the world origin. It takes each axis from the area-weighted normals of all the faces in that direction, makes the frame exactly orthonormal starting from the most precise faces, and sizes its tolerances from the float32 noise of the coordinates, capped at 0.1 rad so noise alone never certifies a non-box. The same 20 mm overlap now reads 20.0 mm and is certified at every placement up to 10 km, where the remaining 0.4 mm is the float32 resolution of the input itself. The TypeScript and Rust/WASM kernels change identically.

On eight sample models the results at their own placement are unchanged.
