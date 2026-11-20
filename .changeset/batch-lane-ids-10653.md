---
"@ifc-lite/renderer": minor
---

Colour-merged batches now record the secondary vertex-lane ids of their pieces as `BatchedMesh.laneIds`, kept through scene snapshots. Hide/isolate classification, the shadow pass, the lane anchor, X-Ray fades, colour-override routing and the selection highlight use primary and secondary ids together, so hiding or isolating an entity that only appears as a secondary id of a merged mesh is drawn correctly, also without CPU geometry.
