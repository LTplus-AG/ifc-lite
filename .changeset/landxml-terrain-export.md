---
"@ifc-lite/wasm": minor
"@ifc-lite/geometry": minor
"@ifc-lite/viewer": minor
---

Export an IFC terrain as a LandXML 1.2 TIN surface (#7600). `IfcAPI.exportLandXmlTerrain`, wrapped as `GeometryProcessor.exportLandXmlTerrain(bytes, productIds, now?)`, writes one `<Surface>` for each selected `IfcGeographicElement` or `IfcSite` whose representation holds exactly one `IfcTriangulatedFaceSet`. An `IfcTriangulatedIrregularNetwork` is accepted only when every `Flags` value is 0. The authored `CoordIndex` is written as `<Faces>` without re-triangulation, with `PnIndex` resolved. Vertices go through the product placement and then the `IfcMapConversion` (or `IfcMapConversionScaled`) of the representation's context, and are written as northing, easting, elevation in metres at micrometre resolution. The `CoordinateSystem` carries the `IfcProjectedCRS` name, plus `epsgCode` for an `EPSG:<n>` name and its geodetic and vertical datums. Surface names are made unique and `OID` is the `GlobalId`.

Missing or ambiguous georeferencing refuses the export instead of guessing. This covers no map conversion or more than one, a non-identity `WorldCoordinateSystem`, `Scale` omitted across a unit change, a unit that cannot be converted to metres, and terrains in different coordinate systems. The error is `TERRAIN_REFUSED:`, followed by the product or attribute at fault. New `@ifc-lite/geometry` exports: `TERRAIN_REFUSED`, `terrainRefusalReason`, and the `LandXmlTerrainExport` and `LandXmlTerrainSurface` types. The viewer adds a **LandXML (terrain)** export that checks the selection with the same exporter and downloads `<model>_terrain.xml`.

KMZ export now writes an XML 1.0-forbidden control character in the document name as U+FFFD. Before, such a name produced a KML document that XML parsers reject.
