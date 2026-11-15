---
"@ifc-lite/wasm": minor
"@ifc-lite/geometry": minor
"@ifc-lite/cli": minor
---

Export a model's buildings as CityJSON 2.0 or CityJSONSeq, the first GIS-native export. Each `IfcBuilding` becomes a `Building` (an `IfcBuilding` decomposing another becomes a `BuildingPart`). It gets an LoD0 footprint, the exact outline of its elements' vertical projection, and an LoD1 block extruded from it, a closed `Solid` with ground, roof and wall semantics. Storeys become `BuildingStorey`, spaces `BuildingRoom`, and elements `BuildingConstructiveElement`, `BuildingInstallation` or `BuildingFurniture`; rooms and elements carry their IFC body geometry at LoD3. Attributes carry `GlobalId`, `Name`, the IFC class, common property sets, `measuredHeight`, `yearOfConstruction`, and Swiss `EGID` / `EGRID` identifiers when a property set holds them.

With one `IfcMapConversion` to an EPSG-named `IfcProjectedCRS`, coordinates are written in that CRS through the full conversion (offsets, rotation, scale, IFC4X3 per-axis factors), and `metadata.referenceSystem` names it. Otherwise the model is written in local metres with a warning and no reference system. Vertices are integers on a millimetre grid by default. A model without an `IfcBuilding` is refused with `CITYJSON_REFUSED:`.

All lengths (coordinates, `measuredHeight`, storey `Elevation`) are in the output CRS's unit. Same-named property sets on one object are merged, with a warning on a conflicting property. A footprint ring that touches itself is split into valid rings instead of dropped. A millimetre project with a metre map unit and no `IfcMapConversion.Scale` stays local, and the warning (shared with the LandXML terrain export) names both units and the `Scale` to set.

The writer ships in the separate export payload (`@ifc-lite/wasm/rhino`, loaded on first use like the Rhino scene builder), so the default engine wasm does not grow. The whole document is built in memory; very large models (around 10 million triangles) will not export.

New: `exportCityJson(bytes, { scale, elementGeometry, sequence })` in `@ifc-lite/geometry` and on `@ifc-lite/wasm/rhino`, `CITYJSON_REFUSED`, `cityJsonRefusalReason`, the `CityJsonExport` and `CityJsonExportOptions` types, and `ifc-lite export --format cityjson|cityjsonseq [--scale STEP] [--blocks-only]`.
