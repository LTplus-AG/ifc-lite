---
"@ifc-lite/renderer": minor
---

Magnetic picking can snap CAD-style to the nearest feature corner on screen. With `snapOptions.screenCornerSnap` set (`{}` for the defaults), `raycastSceneMagnetic` snaps to the nearest corner of an eligible, visible, unclipped mesh whose projection is within `cornerRadiusPx` (10) of the cursor, even when the ray hits another element or nothing, and falls back to the nearest edge within `edgeRadiusPx` (6). Corners outrank edges. `eligibleModelIndices` restricts the search to the models allowed for the pick. Without the option nothing changes.
