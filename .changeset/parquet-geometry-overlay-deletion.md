---
"@ifc-lite/export": patch
---

Fix `ParquetExporter` emitting geometry for an overlay-deleted entity into the `.bos` archive. When a `MutablePropertyView` is supplied, `Entities`, `Properties`, `Quantities`, `Relationships` and `SpatialHierarchy` already dropped a tombstoned entity's rows, but `VertexBuffer.parquet`, `IndexBuffer.parquet` and `Meshes.parquet` never checked the overlay at all — a deleted entity's mesh still exported, so `Meshes.ExpressId` (and the vertices/triangles it indexes) could name an entity `Entities.parquet` had no row for. The three geometry writers now apply the same `isDeleted` filter as the other tables.
