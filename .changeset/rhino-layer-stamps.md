---
'@ifc-lite/rhino3dm': minor
'@ifc-lite/wasm': patch
'@ifc-lite/cli': patch
'@ifc-lite/mcp': patch
---

Rhino .3dm export stamps the layers that stand for the project and the spatial structure (site, building, storey) with `IFC::GlobalId` and `IFC::Class` layer user text, and storeys with `IFC::Elevation` in metres, so a reader can rebuild the IFC spatial tree from the layer table. `RhinoLayer` in the scene manifest gains a required `userStrings` field, which `writeRhino3dm` writes with `Layer.setUserString`.
