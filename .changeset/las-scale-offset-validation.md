---
"@ifc-lite/pointcloud": patch
---

Reject a LAS/LAZ header whose per-axis scale is zero or non-finite, or whose offset is non-finite, instead of silently decoding every point to the same coordinate (`scale = 0`) or to `NaN` (`scale = NaN`, which also poisoned the reported bbox to `±Infinity`) with no diagnostic. `parseLasHeader` now validates `scale`/`offset` the same way it already validates `pointCount`, and `decodeLasPoints`'s bbox fold skips any coordinate that is still non-finite, matching the equivalent guard in `e57-decode.ts` and `ifcx-points.ts`.
