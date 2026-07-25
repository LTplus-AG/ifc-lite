---
"@ifc-lite/clash": patch
"@ifc-lite/wasm": patch
---

Report mesh-level penetration depth for contained contact pairs. When one element's AABB is contained in the other's, hard-clash findings previously reported the AABB signed gap (how deep the small box sits inside the big one) as the penetration depth, overstating depth for designed face contacts such as opening fills. Both the TS and WASM kernels now measure the depth at the crossing triangles' vertices (max point-to-surface inside the other solid), falling back to the AABB estimate only when no such vertex lies inside.
