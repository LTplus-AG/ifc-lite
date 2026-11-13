---
"@ifc-lite/viewer": patch
---

A model whose IfcSite placement repeats the IfcMapConversion anchor in map units instead of the file's length unit lands at its map position again (#9480). Vectorworks 2026 Update 7 writes `311988.18` into a millimetre file where Update 5 wrote `311988180.54`, so the World view applied the conversion on top and put the model about 6 km off and turned. The double-georeference guard now recognises this unit slip as well. The Georeferencing panel says so and points to the fix at source: the IfcSite placement must use the file's length unit, which no IfcMapConversion edit can express. The height in that placement is not recovered.
