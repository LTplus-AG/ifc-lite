---
"@ifc-lite/parser": patch
"@ifc-lite/server-bin": patch
---

The browser and the server now report the same georeferencing for a file whose only georeference is an `IfcProjectedCRS`. A named CRS with no `IfcMapConversion`, or next to a refused one, is the georeference on both sides, with no `source`, and it takes precedence over the `ePSet_MapConversion` and `IfcSite` fallbacks. The server used to skip it and report no georeference or the site location, and it labelled the refused case `mapConversion`. An `IfcProjectedCRS` whose mandatory `Name` is unset or blank no longer counts as a georeference on its own, so the fallbacks run.
