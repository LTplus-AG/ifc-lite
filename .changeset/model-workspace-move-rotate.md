---
"@ifc-lite/viewer": minor
---

The Model workspace rail gets Move and Rotate (#6232 C2). Both act on the selection, one element or several, drawn in the workspace or loaded from the file, and each is one undo step. Move takes a base point and a target point, both snapped, or a typed distance and direction. Rotate draws a ring round the selection's centre, in 3D and in the plan: click on the ring to start the turn, then click again to finish it. The turn snaps to 15° steps (Alt turns freely), an angle can be typed instead, and P picks another point to turn about. Openings and the doors and windows in them move and turn with their wall. Shift+M and Shift+Q start the tools. In the workspace, Move and Rotate handles next to the selection replace the arrow gizmo; outside it the gizmo is unchanged.
