---
"@ifc-lite/clash": patch
---

Internal replacement of the hand-written clash math (vec3, aabb, triangle-intersect) with Plato-generated single-source code. The generated kernel is post-processed by a deterministic codemod that rewrites scalar dispatch to native operators and lifts the former Number/Boolean prototype helpers into a module-scoped namespace, so there is no prototype pollution. The public API is identical and results are bit-identical.
