---
'@ifc-lite/rhino3dm': minor
---

Add `readRhino3dm`, which reads a Rhino `.3dm` into plain `RhinoImport` data: Z-up metres, typed arrays, double-precision origins, layers, colours, Attribute User Text as property sets, and IFC identity (`IFC::GlobalId`, `IFC::Class`) for files ifc-lite exported. Blocks come back as definitions plus instance transforms (or baked with `bakeInstances`), and point clouds, curves and text dots as data. Failures throw `RhinoReadError` with a `code`.
