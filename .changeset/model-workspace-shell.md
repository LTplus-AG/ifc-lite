---
"@ifc-lite/create": patch
"@ifc-lite/viewer": minor
---

The Model workspace gets its shell (#6232). Pressing E, the ribbon's Model button or the status-bar chip opens a tool rail on the viewport's left (Select, Wall, Split, Leave), a storey chip top-left ("Erdgeschoss · ±0.00 m") that lists the storeys and can isolate one, a faint dashed outline of the storey's workplane in 3D, and the new Model inspector in the right sidebar. Leaving puts the previous sidebar panel back. W draws walls and PageUp / PageDown change storey, only inside the workspace. The welcome card's "Start blank model" now opens the workspace drawing walls, and the palette has "Draw walls" and the Model inspector. The top-left "Editing · <model>" chip is gone; the storey chip replaces it.

`extractWallSegmentsForStorey` in `@ifc-lite/create` now reads walls authored this session in metres in every file unit. `addWallToStore` writes the file's native unit, and the extractor took those walls as metres already, so in a millimetre model a new wall came back 1000× too long for wall snapping and auto spaces.
