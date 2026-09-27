---
"@ifc-lite/create": minor
"@ifc-lite/sdk": minor
"@ifc-lite/sandbox": minor
"@ifc-lite/cli": patch
"@ifc-lite/mcp": patch
"@ifc-lite/extensions": patch
"@ifc-lite/viewer": patch
---

Author openings and wall-hosted doors and windows into a loaded model. `@ifc-lite/create` adds `addOpeningToStore` (an `IfcOpeningElement` plus `IfcRelVoidsElement` cut into an existing `IfcWall` or `IfcSlab`, relative to the host's placement, with the cut depth taken from the host's Body thickness by default), `addHostedDoorToStore` and `addHostedWindowToStore` (the opening plus an `IfcDoor` or `IfcWindow` placed in it and linked by `IfcRelFillsElement`), and `resolveHostAnchor`, which reads the host's placement, storey and body bounds from the file and the mutation overlay. Scripts reach them as `bim.store.addOpening`, `bim.store.addHostedDoor` and `bim.store.addHostedWindow` in the SDK, the CLI, the viewer and the sandbox. MCP throws for these, as it does for the other builders. The exported file meshes with the void cut into the host wall.
