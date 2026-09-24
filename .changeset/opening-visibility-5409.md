---
"@ifc-lite/wasm": patch
"@ifc-lite/viewer": patch
---

Every opening now hides with the Openings toggle and draws in the translucent opening overlay (#5409). An opening with an authored style (Revit writes grey onto opening geometry through `IfcIndexedColourMap` and `IfcStyledItem`) rendered as an opaque solid, and the opaque, repeated ones were sent to the GPU-instanced shard, which carries no class, so the toggle could not hide them. `IfcOpeningElement` and its subtypes now always take the opening overlay colour, and no class the viewer toggles as a whole class (spaces, zones, openings, virtual elements, site and terrain, annotations) is ever instanced, so each toggle reaches every occurrence of its class. `IfcOpeningStandardCase` now follows the Openings toggle too. Cached geometry from earlier builds is re-tessellated once.
