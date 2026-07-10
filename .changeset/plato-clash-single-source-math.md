---
"@ifc-lite/clash": patch
---

Internal replacement of the hand-written clash math (vec3, aabb, triangle-intersect) with Plato-generated single-source code. The generated kernel is post-processed by a deterministic codemod that rewrites scalar dispatch to native operators and lifts the former Number/Boolean prototype helpers into a module-scoped namespace, so there is no prototype pollution. A second codemod phase flattens the pure method bodies into tuple-native kernels (inlining + common-subexpression elimination), removing all per-call object allocation. The public API is identical, results are bit-identical, and the end-to-end TS clash engine benchmarks about 20 percent faster than the previous hand-written math.
