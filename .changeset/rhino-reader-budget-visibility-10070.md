---
"@ifc-lite/rhino3dm": patch
---

`readRhino3dm` charges a mesh's vertices to `maxTriangles`: a mesh costs its triangles or a third of a triangle per vertex, whichever is more. Curves and point clouds were already charged by vertex; the budget is now counted in whole thirds of a triangle, so parts that fill it exactly are no longer refused by float rounding (three 5-point curves at `maxTriangles: 5` drew two). A mesh with few triangles over a large vertex array was nearly free before. Meshes whose triangles use every vertex cost the same as before. Each mesh, instance, point cloud, curve and text dot record now carries `hidden`, the flag of the object that drew it, so an entity merged from a group of visible and hidden parts keeps which part Rhino hides (#10070).
