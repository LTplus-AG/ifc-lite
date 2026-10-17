---
'@ifc-lite/clash': patch
---

Box recognition (`detectObb`) now drops degenerate triangles with a scale-free `sin θ` test on each triangle's largest angle instead of a fixed 1e-6 m² cross-product floor, so boxes with sides under about 1.4 mm are recognised and get a certified depth instead of an AABB estimate. Long thin members (a 10 m × 5 mm plate face) stay recognised whichever vertex their triangles start at, and the per-triangle normal noise bound is measured at the same vertex. Identical change in the Rust `ifc-lite-clash` crate; the two share parity vectors.
