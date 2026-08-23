---
"@ifc-lite/viewer": patch
---

Key the 2D-Section pinned-placement cache on the section axis as well as the sheet geometry.

`resolveSheetTransform` returns the per-axis flips as an output so a consumer cannot pair one axis's transform with another axis's flips. The cached transform, however, is a second carrier of those flips: `calculateDrawingTransformForAxis` folds `flipX`/`flipY` into `translateX`/`translateY`. The cache key covered the sheet's id, paper, viewport and scale only, so an entry written by a resolve on one axis was served to a pinned resolve on another — on a 1:100 A3 fixture that puts the drawing centre 140 mm from the viewport centre, off the paper. In the app the axis change also nulls the cache and forces a re-fit, so the mismatch was at most a single frame rather than a persistent one.

The cached entry is now tagged with `sheetTransformCacheKeyOf(sheet, axis)` and validated against it, which makes the pairing unrepresentable at the cache too. Same-axis pinned reads still hit the cache, so pinning is unaffected.
