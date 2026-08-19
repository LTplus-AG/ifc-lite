---
"@ifc-lite/viewer": patch
---

Fix the Split tool committing a slab cut against a stale anchor from a different element.

`setSplitTarget` preserved `splitMode: 'first-anchor'` whenever the slice was mid-slab-cut, regardless of whether the new target was the same element the anchor was latched against. Retargeting Split to a different element — e.g. picking a different row in the Hierarchy panel and re-triggering "Split selected entity" from the Command Palette while a slab's first click was still latched — moved `splitTargetModelId`/`splitTargetExpressId` to the new element but left `slabCutAnchor`/`slabCutFootprint`/`slabCutStoreyElevation` pointing at the old one. The next click then committed `splitSlabByLine` against the new target using an anchor point and footprint from an unrelated slab's coordinate space.

`setSplitTarget` now only preserves the latched anchor when the retarget re-enters the *same* element; retargeting to anything else drops back to `'idle'` and clears the anchor/footprint/elevation, matching what `clearSplitHover` already does for every other exit path.
