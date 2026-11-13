---
"@ifc-lite/viewer": minor
---

Add a Dimension tool to the 2D drawing panel. Click two points, then click where the dimension line goes; hold Shift to lock it horizontal or vertical, and press Esc to cancel. Points snap to endpoints, midpoints, intersections and perpendicular feet of the drawn geometry, with a marker showing the snap kind. Dimensions are drawn with architectural ticks and a whole-millimetre value (or the viewer length unit), can be selected, moved and deleted like other markup, and are counted in the status line. Dimensions drawn on another cut appear dimmed and dashed with an "Other cut" note. They are not yet included in SVG, DXF or PDF exports; the export warning lists them as omitted.
