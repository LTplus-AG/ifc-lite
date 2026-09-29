---
"@ifc-lite/viewer": minor
"@ifc-lite/parser": patch
---

The Model workspace rail gets Room (#6232 M4). Room reads the storey's walls on demand and shows every area they enclose, with its area, in the plan and in 3D. Click inside one to make it an IfcSpace, or switch to Draw and outline a free room as a rectangle or a polygon. Auto makes every enclosed area that has no room yet a room, as one undo step, and never lays a second room over one the model already has. Rooms follow the walls' inner faces, axes or outer faces. A room is a snapshot of the walls when it is made: select rooms and press Update rooms to re-derive their outlines (and floor areas) from the walls as they are now. Shift+O or "Make rooms" in the command palette starts the tool. It replaces the interim "Draw spaces" command, whose rectangle and polygon drawing is now the Room tool's Draw mode.

`effectiveStoreyId` now puts an IfcSpace its storey aggregates on that storey while edits are pending, as it already did without them. Split and Update rooms refused every IfcSpace of an edited model before.
