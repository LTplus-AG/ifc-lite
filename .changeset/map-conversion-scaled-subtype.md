---
"@ifc-lite/parser": patch
"@ifc-lite/export": patch
---

Read and write IFC4X3's `IfcMapConversionScaled`, not just its supertype.

`entityIndex.byType` is keyed by the raw STEP type name, so a georeferencing lookup for `IfcMapConversion` alone never matched a file written with the concrete subtype `IfcMapConversionScaled` — the only subtype it has in any bundled schema, added in IFC4X3.

On the read path this did not merely omit a field. `extractGeoreferencing` produced no `mapConversion`, and therefore no `transformMatrix`, so the model was placed at its local origin instead of its map position — while `hasGeoreference` stayed `true` off the `IfcProjectedCRS` alone and `source` was left undefined. The file reported a projected CRS it could not be transformed into.

On the write path `StepExporter` saw a file with a map conversion as a file with none: a `georefMutations.mapConversion` edit was not applied to the record in the file, and a second coordinate operation was emitted against the same source CRS beside it.

`IfcMapConversionScaled`'s first eight attributes are `IfcMapConversion`'s own (`SourceCRS`, `TargetCRS`, `Eastings`, `Northings`, `OrthogonalHeight`, `XAxisAbscissa`, `XAxisOrdinate`, `Scale`); the three it adds — `FactorX`/`FactorY`/`FactorZ` — sit after them, so reading it as its supertype is well-defined and the exporter's by-name attribute edits leave that tail alone.

`MAP_CONVERSION_TYPE_NAMES` is now exported from `@ifc-lite/parser` so any consumer of `extractGeoreferencing` widens identically, and both it and the exporter's uppercase twin are pinned against the generated per-schema entity tables in both directions, so neither can silently fall behind a schema bump. The Rust extractor (`ifc-lite-processing`) classified by the same raw name and had the same gap; it is widened to match.
