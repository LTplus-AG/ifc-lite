---
"@ifc-lite/viewer": minor
---

The Model workspace plan gets direct-edit handles for the selected element (#6232 B3). A wall shows a handle at each end: drag one and the end follows the snapped cursor, with the same command, and so the same edit, as the 3D end handle. A door, window or opening shows a slide handle: drag it along its wall to change its offset. It stops at the wall's ends, and its void moves with it. A wall or other element that can be moved shows a move handle at its middle: drag it to move the element, with snapping. Handles keep the same size at any zoom, a click on one still selects, and each drag is one undo step. While a wall end or a slide is dragged, its preview shows in the plan and in 3D.
