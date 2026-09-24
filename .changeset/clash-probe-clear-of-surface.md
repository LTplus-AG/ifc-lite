---
"@ifc-lite/clash": patch
"@ifc-lite/wasm": patch
---

Flush contacts are no longer reported as hard clashes at an element dimension depending on where the model sits.

When two elements' bounding boxes overlap but no triangles cross, the engine decides between a hard clash and a face touch by checking whether a probe point lies inside both solids. For elements that meet flush, the probe (the centre of the bounding-box overlap) lies on the shared face, where the inside/outside test is decided by float32 rounding. When it came out "inside", the pair was reported as a hard clash at the bounding-box overlap, e.g. 0.5 m for two footings or 0.3 m for two walls. Moving the whole model changed which pairs that happened to.

A probe now counts only when it is farther from each surface than the pair's own depth floor along the probe's direction, the same floor that decides hard vs touch. The enclosed-solid check uses the same rule, so there is one definition of "clearly inside". On the sample models this turns 87 such pairs (12 on one model, 75 on another) from hard clashes into touches. In every one, no vertex of either element lies deeper inside the other than that floor. No new hard clashes appear, and the verdicts that change when a model is moved 10 km drop on every affected model (from 145 to 75 on the largest; to 0 on another).
