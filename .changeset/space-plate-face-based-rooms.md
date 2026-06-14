---
"@ifc-lite/wasm": minor
---

`SpacePlateHandle` gains `fromWallRects(rectCoords, snapTolerance, minArea)`: build
a plate from each wall's footprint **rectangle** (4 corners, wall-major) instead of
its centreline. Rooms are detected as the bounded **gaps between** the rectangles
(a face is a room iff its centroid is outside every rectangle), so the room
boundary lands on the wall faces with no centreline distribution bias — then each
room is LIFTED to its wall axis, so the returned plate is a normal centreline plate
whose room outlines are the wall axes and whose vertices are the editable nodes.
Every edit op (drag / split / merge) therefore acts directly on what's displayed,
and `netOutline(face, inset)` recovers the inner (net) / outer (gross) faces.

Room classification is now a stable per-face flag set once at build and carried
through edits (split inherits it, merge ORs it) — so dragging a vertex or cutting a
room can no longer silently re-classify faces into phantom rooms.
