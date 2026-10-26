---
"@ifc-lite/parser": minor
"@ifc-lite/pointcloud": minor
"@ifc-lite/server-client": minor
---

Georeferencing reads the IFC4X3 coordinate operations beside `IfcMapConversion`. An `IfcRigidOperation` (a pure translation) is read into `mapConversion` with `operation: 'rigidOperation'`, an identity axis and unit scale, and `source: 'rigidOperation'`. Length measures translate map coordinates. Plane-angle measures translate (longitude, latitude) of an `IfcGeographicCRS` in its AngleUnit, else the project plane-angle unit. An `IfcMapConversion` still takes precedence when both are authored. The CRS read is now the operation's own TargetCRS (`IfcProjectedCRS` or `IfcGeographicCRS`, the latter with `kind: 'geographic'`), falling back to the first CRS in the file as before. An `IfcWellKnownText` attached to that CRS is exposed as `projectedCRS.wellKnownText` (`well_known_text` from the server), and a CRS defined only by its WKT counts as georeferenced. `@ifc-lite/pointcloud` adds `extractWktHorizontalCrs` and `extractWktBoundingBox`.
