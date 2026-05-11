---
"@ifc-lite/pointcloud": minor
---

E57 multi-scan pose merging — registered files now load.

Previously a multi-scan E57 with `<pose>` elements threw a clear
"re-export as merged" error. This change parses each Data3D's pose
(unit quaternion + translation) and applies it before merging, so
registered scans line up in the file's global frame.

Implementation:
- `Data3DEntry.hasPose: boolean` → `Data3DEntry.pose?: E57Pose`
  carrying `{ rotation: {w,x,y,z}, translation: {x,y,z} }`.
- New `parsePoseElement` walks the `<pose><rotation/><translation/></pose>`
  structure; non-finite values fall through to identity rather than
  rejecting the whole file.
- New exported `applyPoseInPlace(positions, count, pose)` derives the
  3×3 rotation matrix from the quaternion (Hamilton convention,
  `w + xi + yj + zk`) and computes `out = R · in + T` per point.
- `decodeE57` applies the pose after `decodeE57Scan` returns and
  recomputes bbox; identity / absent poses are no-ops.
- The "Multi-scan pose merging is not yet supported" rejection is
  removed.

3 new tests:
- Pose extraction from XML (90°-around-Z quaternion + finite
  translation, plus a no-pose sibling).
- `applyPoseInPlace` with a 90°-around-Z + translation, asserting
  per-axis transforms.
- Identity pose round-trips positions unchanged.

Verified: 64 pointcloud unit tests pass, full repo typecheck (24/24),
viewer Vite build green.
