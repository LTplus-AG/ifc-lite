---
"@ifc-lite/viewer": minor
"@ifc-lite/create": minor
---

The Room tool (#6232 M4) now does everything Space Sketch did. Its new Edit mode reshapes the storey's room layout in the plan and in 3D: drag a corner and every room that shares it follows, cut a room between two points on its outline, merge two rooms across the wall between them, remove a corner, or Clean up loose walls and nodes. Each edit rewrites the rooms it touches as one undo step, and undo and redo bring the layout back with them. Under More, Footprint makes one room over the storey's whole outline (an L-shaped plan stays an L), Auto on every storey fills the whole building in one undo step, the corner weld closes walls that meet with a small gap, and Show leaks marks the walls that enclose nothing and the wall ends that touch nothing.

`existingSpaceFootprintsByStorey` returns each existing IfcSpace's footprint as a ring: a faceted space (a triangulated or polygonal face set, or a faceted brep) is outlined by its up-facing faces instead of returned as an unordered cloud of its vertices, and a space authored in the session of a millimetre model is scaled to metres like a parsed one. The new `existingSpaceFootprintEntriesByStorey` also names the space each footprint belongs to.
