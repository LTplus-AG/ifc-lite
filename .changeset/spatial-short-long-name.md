---
"@ifc-lite/data": minor
"@ifc-lite/parser": minor
"@ifc-lite/ifcx": minor
---

Carry a spatial node's IFC `LongName` through the hierarchy so the spatial structure can show both the short code and the descriptive label, e.g. "01" + "Main Residence" (issue #1634):

- `@ifc-lite/data`: `SpatialNode` gains an optional `longName?: string` (the descriptive name, kept only when present and distinct from `name`). Additive and optional; existing consumers are unaffected.
- `@ifc-lite/parser`: `SpatialHierarchyBuilder` now reads `LongName` off the source record by schema attribute *name* and populates `SpatialNode.longName`. Resolving by name (not a fixed index) keeps it correct across the IfcRoot family, since `IfcProject` carries `LongName` at a different index than the `IfcSpatialStructureElement` subtypes; the lookup spans the bundled schema union (2X3 + 4 + 4X3) via the new `getAttributeNamesAcrossSchemas`, so IFC4.3 facility/infra containers (`IfcFacility`, `IfcBridge`, `IfcRoad`, …) outside the parser's IFC4 codegen pin resolve too. When `Name` is empty it falls back to `LongName` for the primary label. The source-less `buildFromCache` path leaves it undefined, exactly like storey elevation. `data-store-transport` serializes the new field so the worker→main transfer preserves it.
- `@ifc-lite/ifcx`: the IFCX/IFC5 hierarchy builder populates `SpatialNode.longName` from `bsi::ifc::prop::LongName` for parity.
