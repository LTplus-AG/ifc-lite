---
"@ifc-lite/wasm": patch
---

The CSG kernel now rounds each coordinate of a computed intersection point once, to the nearest f64. It used to round the numerator and the denominator to f64 and then divide, so a point lying exactly on an axis-aligned plane could come back an ulp off it. On the ISSUE_068 school wall #43810, with the site offset and a per-element local frame (the frame wasm `process_geometry` and the appearance router use), that left one vertex of the jamb shared by two abutting openings off the jamb's plane. The next cut then left a T-junction there, and cleanup widened it to 15 open edges. That wall is now closed in every frame. Over 117 fixture models (212,018 meshes, world and local frame) no other mesh changes its triangle count, open edges or area.
