---
"@ifc-lite/wasm": minor
"@ifc-lite/geometry": minor
"@ifc-lite/viewer": minor
---

The LandXML (terrain) export gets options, matching the other export dialogs (#7618).
- **Units:** metres, international feet or US survey feet. US survey feet write heights in international feet, because LandXML 1.2 has no US-survey-foot elevation unit; both units are declared in `<Units>`.
- **Decimal places:** 3, 4 or 6.
- **Surface name:** editable per surface.

The dialog adds an Output row, a Units select, a Decimal places select and an editable name per surface. The options apply when you export, and the selection check is not repeated.

`IfcAPI.exportLandXmlTerrain(content, productIds, options)` now takes one typed options object `{ date, time, linearUnit?, decimals?, surfaceNames? }`. `GeometryProcessor.exportLandXmlTerrain(bytes, productIds, options?)` takes `LandXmlTerrainExportOptions`, with `now` moved into the options. Both replace the unreleased #7600 signatures. Defaults are unchanged: metres, 6 decimals and the IFC names.
