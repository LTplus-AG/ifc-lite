---
'@ifc-lite/mutations': patch
---

Fix `BulkQueryEngine.select()` silently ignoring `SelectionCriteria.sites`.

`sites?: number[]` was declared on `SelectionCriteria` ("Filter by site IDs")
and `SpatialHierarchy.bySite` was populated to serve it, but `select()` had no
branch reading `criteria.sites` — unlike its `storeys`, `buildings` and
`spaces` siblings, which each filter candidates through their matching
`SpatialHierarchy` map. A caller who scoped a bulk `SET_PROPERTY`,
`DELETE_PROPERTY`, or `SET_ENTITY_TYPE` to one site got the whole model
mutated instead, with no error.

The new `sites` branch is structurally identical to `storeys` / `buildings` /
`spaces`: same guard (`criteria.sites.length > 0 && this.spatialHierarchy`),
same per-ID lookup through `bySite.get(id)` skipping unknown IDs, same
intersection semantics when combined with other criteria. An empty `sites`
array is treated as no filter, matching the existing sibling behavior.

Known, separately-tracked gaps left unfixed (both already self-documented as
incomplete, so not a silent bug like the one above): `applyAction`'s
`SET_ATTRIBUTE` case returns `null` unconditionally ("would need to be
implemented"), and `CsvConnector.matchRow`'s `'property'` strategy warns
"not yet implemented" and matches nothing.
