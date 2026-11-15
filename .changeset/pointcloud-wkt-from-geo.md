---
"@ifc-lite/pointcloud": patch
---

The WKT helpers (`extractWktSpatialMetadata`, `extractWktCrsIdentifiers`, `extractWktHorizontalCrs`, `extractWktBoundingBox` and their types) now live in `@ifc-lite/geo/wkt`; `@ifc-lite/pointcloud` depends on `@ifc-lite/geo` and re-exports them under the same names, so its API is unchanged.
