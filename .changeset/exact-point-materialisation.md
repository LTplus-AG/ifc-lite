---
"@ifc-lite/wasm": patch
---

The CSG kernel now returns a computed intersection point's coordinate exactly when that coordinate is an input-grid value (a multiple of 2^-16, or 2^-36 on welded seams), as it is for a point lying on an axis-aligned plane. It rounds the numerator and the denominator to f64 and then divides, as before, which can land an ulp off; when that result is within a few ulps of a grid value and an exact integer check shows the true quotient is that value, the grid value is returned instead. On the ISSUE_068 school wall #43810, with the site offset and a per-element local frame (the frame wasm `process_geometry` and the appearance router use), the ulp error left one vertex of the jamb shared by two abutting openings off the jamb's plane. The next cut then left a T-junction there, and cleanup widened it to 15 open edges. That wall is now closed in every frame.
