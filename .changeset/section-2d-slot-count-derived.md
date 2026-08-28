---
'@ifc-lite/renderer': patch
---

Derive `SECTION_2D_UNIFORM_SLOT_COUNT` from `Object.keys(SECTION_2D_UNIFORM_SLOT_INDEX).length` instead of a hand-written `6`, so adding a draw site to the index can no longer leave the shared uniform buffer one slot short of what the index addresses. A test pins the two values equal so a future divergence fails loudly instead of only showing up as a WebGPU bind-group validation error on the new draw site.
