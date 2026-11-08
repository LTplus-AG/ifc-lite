---
"@ifc-lite/create": minor
"@ifc-lite/viewer": patch
---

Copy, paste, duplicate and array now work on an element placed on a grid ([#9199](https://github.com/LTplus-AG/ifc-lite/issues/9199)). A copy binds to the grid crossing it lands on, so an array at the bay spacing stays on the grid. A copy that lands on no crossing comes free as a plain storey-placed element, and the viewer says how many came free. This covers assemblies with a grid-bound part. `CopyProductResult` gains `boundToGrid` and `cameFree`, and `gridAxisIntersections` moves from the viewer's snap source to `@ifc-lite/create`.
