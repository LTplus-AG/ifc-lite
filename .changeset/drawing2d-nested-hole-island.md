---
"@ifc-lite/drawing-2d": patch
---

Fix `PolygonBuilder.classifyLoops` misclassifying an island (e.g. a mullion cross-section, or a column stub) nested inside a hole as a second hole of the outer boundary, instead of a solid polygon in its own right. Previously every ring's containment was tested only against the top-level outer boundary, so anything geometrically inside it — at any nesting depth — became a hole, silently turning the island into void in the rendered section drawing. Loops are now classified by nesting depth relative to their nearest containing ancestor: even depth is a solid outer boundary, odd depth is a hole of its immediate parent.
