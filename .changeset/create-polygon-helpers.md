---
"@ifc-lite/create": minor
---

`polygonArea(ring)`, `pointInPolygon(x, y, ring)` and the `PolygonRing` type are exported. They are the shoelace area and even-odd containment test the room, slab, space, structural and base-quantity builders measure with, now one module instead of five private copies, so a caller checking a room outline against the same rules as `detectEnclosedAreas` and `offsetRoomFootprint` no longer re-implements them.
