---
"@ifc-lite/viewer": patch
"@ifc-lite/sdk": minor
---

The Georeference panel's georeferencing check now applies IfcSite RefLatitude / RefLongitude / RefElevation fixes, and the panel shows the site location as editable rows. The values are written as one undoable edit in the encoding `bim.georef.setSite` uses (IfcCompoundPlaneAngleMeasure to the millionth of a second), survive IFC export, and the check re-runs over them. The Properties panel's attributes show a numeric positional edit such as RefElevation. `@ifc-lite/sdk/georef-doctor` exports `planSiteWrite`, `readSiteValues`, `SITE_SLOTS`, `GeoreferencingError` and the `GeorefSiteInput` / `SiteWritePlan` types; `planSiteWrite` takes `'all'` as owned edits for a host whose undo history holds every edit.
