---
"@ifc-lite/clash": patch
---

Drop the no-op dedup `Set` from `queryMeshCross`, removing a quadratic allocation and an uncapped `Set` from contact clustering's inner loop.

`queryMeshCross` funnelled its candidate triangle pairs through a `Set` keyed `` `${iA}|${iB}` ``, described in its own comment as "belt-and-braces" because BVH leaves partition the triangle set. That reasoning holds, and the set removed nothing: `buildNode` splits a node's indices into disjoint, covering halves and a leaf keeps exactly its own slice, so every triangle lives in exactly one leaf; and `crossNode` reaches any node pair by a single route, descending both sides together while both are internal and only the internal side once the other is a leaf. Each leaf pair is therefore visited once and each `(iA, iB)` emitted at most once.

What it did cost was one key string and one `Set` entry per emitted pair — O(triangles_A × triangles_B) in the worst case, for a single element pair, with no cap. `Set` shares V8's hard 2^24-entry ceiling, and 4096 × 4096 = 2^24, so two roughly 4k-triangle elements whose AABB filter passes nearly everything sit exactly on it.

Output is unchanged, in content and in order. New tests pin the emitted pair list against a brute-force ground truth across leaf sizes, triangle counts, epsilons and lopsided trees, and check the leaf partition directly; deliberately breaking either the partition or the traversal's single-visit property makes them fail.
