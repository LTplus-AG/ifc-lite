---
'@ifc-lite/clash': patch
---

Box recognition (`detectObb`) now drops degenerate triangles with a scale-free `sin θ` test instead of a fixed 1e-6 m² cross-product floor, so boxes with sides under about 1.4 mm are recognised and get a certified depth instead of an AABB estimate. Identical change in the Rust `ifc-lite-clash` crate; the two share parity vectors.
