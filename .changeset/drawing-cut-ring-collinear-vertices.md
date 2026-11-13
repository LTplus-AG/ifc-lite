---
"@ifc-lite/drawing-2d": patch
---

Section cut polygons no longer keep tessellation split points on straight faces. A planar cut through a triangulated face returns one segment per triangle, so a straight wall face used to reach the cut ring as two or more collinear edges, split where a triangle diagonal crossed the plane. The 2D measure tool snapped to those invisible points (a 6 m wall measured 4.26 m between "endpoints"). The polygon builder now drops ring vertices that lie on the chord between their neighbours, within 1% of the weld tolerance, so corners, fine arcs and backtracking spikes keep their vertices and the cut lines are unchanged.
