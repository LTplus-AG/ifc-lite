---
"@ifc-lite/clash": patch
---

Pin eight untested comparison-operator boundaries in the clash geometry kernel with exact-boundary fixtures found by mutation testing (flipping the operator killed zero tests): `contact/aabb.ts`'s `intersects()`, `contains()`, and `longestAxis()`; `contact/bvh.ts`'s and `contact/mesh-bvh.ts`'s inflated-bounds overlap checks; and `engine-ts/obb.ts`'s zero-thickness reject, noise-band skip, and through-penetration far-side check. No production logic changed — this is coverage-only.
