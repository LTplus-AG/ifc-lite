---
"@ifc-lite/viewer": patch
---

Fix `TypeError: entities.getTypeName is not a function` when picking a
point on a streamed point cloud (LAS / LAZ / PLY / PCD / E57).

The synthetic `IfcDataStore` that `pointCloudIngest.ts` builds for
point-cloud-only models stubbed `entities` with only a handful of
methods (`getId`, `getType`, `getName`, `getGlobalId`) and used method
names that don't match the real `EntityTable` interface. Picking
selects the synthetic expressId, which routes through the regular
property / hover / properties-panel pipeline — that pipeline calls
`entities.getTypeName`, `entities.getTypeEnum`,
`properties.getForEntity`, etc., and crashed on the missing
`getTypeName`.

`emptyDataStore()` now produces a stub that matches the real shape:

  - `entities`: `count=1`, `expressId=Uint32Array([id])`, `typeEnum`,
    plus `getTypeName` → `'IfcGeographicElement'`, `getName` → file
    name, `getGlobalId` → `pointcloud-<id>`, and `getTypeEnum`,
    `getByType`, `hasGeometry`, `getExpressIdByGlobalId`,
    `getGlobalIdMap` covered.
  - `properties`: real `PropertyTable` shape — `entityIndex`,
    `psetIndex`, `propIndex`, `getForEntity`, `getPropertyValue`,
    `findByProperty` (all empty / no-op).
  - `quantities` / `relationships`: matching empty stubs.
  - `entityIndex.byType` includes `IFCGEOGRAPHICELEMENT → [id]` so type
    filters resolve.

`emptyDataStore` now takes the synthetic `expressId` and `fileName` so
the stub round-trips real data instead of `undefined`.
