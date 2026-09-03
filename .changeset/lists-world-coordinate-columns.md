---
'@ifc-lite/lists': minor
---

Add a `geometry` column/condition source (issue #3671, "Reporting World Coordinates in Lists"): `propertyName` selects `X` | `Y` | `Z` (default `X`) of the element's World Coordinate, in the project's own coordinate system and IFC Z-up axes, project length units. This is PROJECT space, distinct from the map/WGS84 georeferenced frame.

The value is the CENTRE of the element's world bounding box, not its `IfcLocalPlacement` origin. For an L-shaped slab or a curved wall those differ, and the centre can fall outside the element itself.

`ListDataProvider` gains an optional `getWorldPosition(expressId)` accessor to back it; providers built before this existed simply have no World Coordinate columns, the same graceful-degrade contract as every other optional accessor.

`geometry` columns resolve through the existing generic numeric sort/filter machinery, so sorting works and the engine supports `gt`/`lt` conditions. The list builder UI does not yet offer `geometry` as a condition source, so those conditions can currently only be authored programmatically.

Elements whose whole mesh set went to the GPU-instanced shard report no World Coordinate: they never appear in `GeometryResult.meshes`, and `instancedGeometryAabbs` is not consulted yet. Their cells are blank rather than wrong.
