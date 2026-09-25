---
"@ifc-lite/viewer": patch
---

Every model export now downloads under the model's name, whichever surface started it (#5833). The mobile GLB export no longer saves `model.glb`, the location map's Google Earth button no longer saves `model.kmz`, a merged federation export is named after its first model instead of `merged_export.ifc`, and the one-click CSV, JSON and screenshot exports carry the active model's name (`Haus_entities.csv`, `Haus_data.json`, `Haus_screenshot.png`). The GLB, KMZ, energy-model and clash CSV exports use the shared extension stripping, so a second copy of a file (`Haus.ifc (2)`) no longer downloads under the first copy's name.
