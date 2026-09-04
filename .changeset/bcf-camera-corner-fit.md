---
'@ifc-lite/bcf': patch
---

Frame IDS report cameras from the box corners, not the largest side

`computeCameraFromBounds` derived its standoff from the longest side of the
entity bounds times a fixed factor. A side length is not what the projection
sees: down the southeast-isometric axis the camera uses, a box projects wider
than any of its sides, so the worst corner of a unit cube sat outside the
frustum at 16/9 (vertical slope 0.837 against the tan(30 deg) = 0.577 limit)
and outside it horizontally at 9/16 (0.344 against 0.325).

The distance is now the smallest standoff that puts all eight corners inside
both half-angles for the given field of view and aspect ratio, with the same
1.5x padding on top. The view direction and up vector are unchanged. Cameras
for boxes that were already cropped move further out; a landscape export of a
cube frames exactly as a square one does.
