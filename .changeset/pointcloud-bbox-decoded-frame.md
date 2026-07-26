---
'@ifc-lite/pointcloud': patch
'@ifc-lite/renderer': patch
---

Report LAS/LAZ streaming bounds in the frame the points are actually emitted
in, and single-source the point-cloud model-matrix guard.

`LasStreamingSource`/`LazStreamingSource` returned the raw `header.bbox` while
every decoded point has `originOffset` subtracted first, leaving bounds and
points off by the full offset — at map magnitudes that misdirects scene
framing, culling and the height-ramp colour range. Both sources now translate
through the shared `bboxInDecodedFrame` helper.

`transformAabb` and `writePointCloudUniforms` also carried separate 4x4
validity checks, neither rejecting non-finite entries; both now share
`isUsableModelMatrix`, so a degenerate matrix falls back to identity in both
consumers rather than in only one.
