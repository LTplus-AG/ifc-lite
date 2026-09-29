---
"@ifc-lite/create": minor
"@ifc-lite/viewer": minor
---

The Model workspace rail gets Slab, Column and Beam (#6232). Slab draws a rectangle (two corners; Shift squares it; typed Width and Depth lock a side) or a polygon (a click per corner; Enter, a double-click or a click on the first corner closes it), and writes an IfcSlab, IfcRoof or IfcPlate. Column places one column per click; R turns it 15° and Rotation takes a typed angle. Beam draws beams or members the way Wall draws walls, with their underside at a typed "Bottom at". The Wall bar gains Align (the drawn line is the wall's left face, axis or right face) and Chain (keep drawing from the last end). Shift+S, Shift+C and Shift+B start the three tools, and the palette lists them. Each placed element is one undo step.

`addColumnToStore` in `@ifc-lite/create` takes an optional `RefDirection`: the horizontal direction of the section's Width axis, normalised. Column placements now always carry an explicit `Axis` and `RefDirection`. Before this, rotating an authored column was refused, because a placement with no RefDirection cannot be turned.
