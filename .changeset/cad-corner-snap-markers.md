---
"@ifc-lite/renderer": minor
---

Corner snapping can publish snap markers. With `screenCornerSnap.markers` set, each magnetic pick lists the eligible, visible, unclipped corners within `markerRadiusPx` (48) of the cursor, nearest first and at most `markerLimit` (12), through `Renderer.cornerMarkers` (`get()` the latest `ScreenCornerMarkers`, `subscribe` to changes). The list comes from the same grid and the same occlusion rule as the snap itself (`ignoreOcclusion` included), carries the index of the corner the pick used, and is empty while the camera is moving. `ScreenCornerIndex.candidatesNear` is the underlying query. Without the option nothing changes.
