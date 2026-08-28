---
'@ifc-lite/renderer': patch
---

Derive `SECTION_2D_UNIFORM_SLOT_COUNT` from `Object.keys(SECTION_2D_UNIFORM_SLOT_INDEX).length` instead of a hand-written `6`, so adding a draw site to the index can no longer leave the shared uniform buffer one slot short of what the index addresses. A test pins `SECTION_2D_UNIFORM_SLOT_INDEX` to be dense — every value from `0` to `SECTION_2D_UNIFORM_SLOT_COUNT - 1` used exactly once — so a sparse index (a slot bumped past the end while leaving a gap, the actual shape of the #3342 bind-group failure) fails loudly instead of only showing up as a WebGPU bind-group validation error on the new draw site.
