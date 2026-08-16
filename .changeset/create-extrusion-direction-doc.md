---
"@ifc-lite/create": patch
---

Correct the `ExtrusionDirection` API docs on `addElement`: the direction is expressed in the profile's coordinate system and must have a non-zero Z component (IFC4 `IfcExtrudedAreaSolid.WR31`). The previous doc recommended `[1, 0, 0]` "for along X", which lies in the profile plane and sweeps the profile into a zero-volume sheet - invalid IFC that meshes to a flat ribbon. To orient an element in the model (e.g. a horizontal pipe), keep the default `[0, 0, 1]` and set `Placement.Axis` instead.
