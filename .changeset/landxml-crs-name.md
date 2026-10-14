---
"@ifc-lite/wasm": patch
"@ifc-lite/viewer": patch
---

LandXML import now reads `CoordinateSystem@name` (#7604). The parsed coordinate system, from `parseLandXmlTinBytes` and the streamed LandXML header, carries `name` beside `horizontal_datum`, `vertical_datum` and `epsg_code`. The LandXML → IFC4X3 export names `IfcProjectedCRS` by the declared EPSG code as `EPSG:<n>` when there is one, else by `CoordinateSystem@name`, else by `horizontalDatum`. A CRS with no EPSG code, such as `<CoordinateSystem name="CH1903+ / LV95"/>`, now gets its `IfcProjectedCRS` and `IfcMapConversion`. Before, a name-only declaration wrote no georeferencing, and a name with a datum was renamed to the datum, so an IFC → LandXML → IFC round trip lost the CRS name or the map conversion. Files that declare an `epsgCode` keep their `EPSG:<n>` name.
