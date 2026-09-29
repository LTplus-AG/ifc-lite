---
"@ifc-lite/viewer": minor
---

The Model workspace can draw spaces (#6232). "Draw spaces" in the command palette starts an interim Space command: a rectangle (two corners) or a polygon (a click per corner; Enter, a double-click or a click on the first corner closes it), written as an IfcSpace under the current storey with the space Height default, one undo step each. Spaces are shown once one is drawn. The Room tool will replace this command's controls.
