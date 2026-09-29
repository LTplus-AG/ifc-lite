---
"@ifc-lite/viewer": minor
"@ifc-lite/parser": patch
---

The Model workspace rail gets Room (#6232 M4). Room reads the storey's walls on demand and shows every area they enclose, with its area, in the plan and in 3D. Click inside one to make it an IfcSpace, or switch to Draw and click the corners of a free room. Auto makes every enclosed area that has no room yet a room, as one undo step, and never lays a second room over one the model already has. Rooms follow the walls' inner faces, axes or outer faces. A room is a snapshot of the walls when it is made: select rooms and press Update rooms to re-derive their outlines (and floor areas) from the walls as they are now. Shift+O starts the tool.

`effectiveStoreyId` now puts an IfcSpace its storey aggregates on that storey while edits are pending, as it already did without them. Split and Update rooms refused every IfcSpace of an edited model before.
