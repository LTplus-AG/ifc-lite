---
"@ifc-lite/renderer": patch
---

X-Ray now fades GPU-instanced geometry too, instead of leaving it solid.

The instanced pass received only the hide and isolate sets, so ghosting stopped at the flat geometry. On a model whose facade is instanced — repeated panels, mullions, windows — asking to X-ray the building produced a solid facade standing in front of a ghosted interior. The Cesium world view had already started fading them correctly (#2591), and that disagreement is what surfaced the gap.

`Scene.setInstancedGhosting` fades every occurrence outside the except-set to the same `DEFAULT_GHOST_ALPHA` the flat path uses, leaves the selection solid exactly as the flat path does, and reports the result through `hasTransparentInstances()` so the translucent sub-pass actually runs.

It composes with lens and IDS colour overrides rather than fighting them: the two share the instance colour bytes, so a ghosted occurrence keeps its override's RGB and takes the ghost alpha, and clearing X-Ray restores the override rather than the original colour. Diffed against the previous ghost set, so the per-frame call is a no-op when nothing changed.
