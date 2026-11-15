---
"@ifc-lite/wasm": minor
"@ifc-lite/geometry": minor
"@ifc-lite/cli": minor
---

Export a model's buildings as CityJSON 2.0 or CityJSONSeq, the first GIS-native export. Each `IfcBuilding` becomes a `Building` (an `IfcBuilding` decomposing another becomes a `BuildingPart`). It gets an LoD0 footprint, the exact outline of its elements' vertical projection, and an LoD1 block extruded from it, a closed `Solid` with ground, roof and wall semantics. Storeys become `BuildingStorey`, spaces `BuildingRoom`, and elements `BuildingConstructiveElement`, `BuildingInstallation` or `BuildingFurniture`; rooms and elements carry their IFC body geometry at LoD3. Attributes carry `GlobalId`, `Name`, the IFC class, common property sets, `measuredHeight`, `yearOfConstruction`, and Swiss `EGID` / `EGRID` identifiers when a property set holds them.

With one `IfcMapConversion` to an EPSG-named `IfcProjectedCRS`, coordinates are written in that CRS through the full conversion (offsets, rotation, scale, IFC4X3 per-axis factors), and `metadata.referenceSystem` names it. Otherwise the model is written in local metres with a warning and no reference system. Vertices are integers on a millimetre grid by default. A model without an `IfcBuilding` is refused with `CITYJSON_REFUSED:`.

New: `IfcAPI.exportCityJson`, `GeometryProcessor.exportCityJson(bytes, { scale, elementGeometry, sequence })`, `CITYJSON_REFUSED`, `cityJsonRefusalReason`, the `CityJsonExport` and `CityJsonExportOptions` types, and `ifc-lite export --format cityjson|cityjsonseq [--scale STEP] [--blocks-only]`.
