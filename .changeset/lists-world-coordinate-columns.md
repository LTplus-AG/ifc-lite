---
'@ifc-lite/lists': minor
---

Add a `geometry` column/condition source (issue #3671, "Reporting World Coordinates in Lists"): `propertyName` selects `X` | `Y` | `Z` (default `X`) of the element's World Coordinate — the fully composed, resolved `IfcLocalPlacement` chain in the project's own coordinate system and IFC Z-up axes, project length units. This is PROJECT space, distinct from the map/WGS84 georeferenced frame. `ListDataProvider` gains an optional `getWorldPosition(expressId)` accessor to back it; providers built before this existed simply have no World Coordinate columns, the same graceful-degrade contract as every other optional accessor. `geometry` columns resolve through the existing generic numeric sort/filter machinery, so they can be sorted and filtered (`gt`/`lt`/etc.) exactly like any other numeric column.
