---
'@ifc-lite/parser': minor
'@ifc-lite/server-client': minor
---

Georeferencing TS↔Rust parity (alignment audit phase 1):

- `@ifc-lite/parser`: `extractGeoreferencing` gains the IFC2x3 `ePSet_MapConversion` fallback with the same precedence as the Rust extractor (`IfcMapConversion` → ePSet → legacy `IfcSite` lat/long); `GeoreferenceInfo.source` union widens to include `'ePSetMapConversion'`.
- `@ifc-lite/server-client`: `Georeferencing` gains optional `crs_description`, `map_zone`, `map_unit`, `map_unit_scale`, and `source` fields — the server now reports MapUnit-scaled conversions (e.g. 0.001 for millimetre-based files), picks the FIRST authored `IfcMapConversion` like the browser parser, normalises non-unit X-axis directions so `transform_matrix` agrees with `rotation_degrees`, and recognises site-only models via the `IfcSite.RefLatitude/RefLongitude` fallback.
