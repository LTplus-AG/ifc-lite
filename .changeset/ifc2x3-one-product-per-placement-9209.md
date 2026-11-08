---
'@ifc-lite/export': patch
'@ifc-lite/wasm': patch
---

An IFC2X3 export now validates where a placement places no product or several. IFC2X3 requires exactly one, IFC4 allows any number, and ifc-lite writes both cases: a column on a grid sits under a local placement below its `IfcGridPlacement`, and a blank model's site and building share one placement. On IFC2X3 export, a column with no heading and no offset in plan keeps its grid binding, folded into a single `IfcGridPlacement` that carries its height as the intersection's third offset. A column with a heading or an offset gets a plain `IfcLocalPlacement` in the grid's frame at the same position. A shared placement is copied for each further product. IFC4 and IFC4X3 exports are unchanged.
