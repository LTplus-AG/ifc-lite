---
"@ifc-lite/data": minor
---

The bundled EPSG index now carries each CRS's area of use, native unit and compound components, so headless checks can tell when coordinates lie outside the CRS they claim. The data is a separate lazily loaded module (about 59 KB gzipped, loaded only on first use) and the search index itself is unchanged. New exports: `getEpsgAreaOfUse` / `getEpsgAreasOfUse` (WGS84 bounding box, `west > east` with `crossesAntimeridian` for extents that cross the date line), `getEpsgUnit` (name and metres per unit), `getEpsgCompoundComponents`, `isLonLatInAreaOfUse` / `isLonLatInEpsgAreaOfUse` (with a degree margin, antimeridian-aware) and `createEpsgCrsCatalog()`, a synchronous `lookup(code)` / `resolveName(name)` catalog. Regenerate with `pnpm generate:epsg-extents`.
