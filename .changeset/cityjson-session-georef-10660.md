---
"@ifc-lite/viewer": patch
---

CityJSON and CityJSONSeq export now write the effective georeferencing: georeferencing added or edited in the current session is applied over the file's own, giving `metadata.referenceSystem`, the transform and the geographical extent. The dialog names the CRS it will write instead of saying session edits are left out, and the `exports.cityjson` agent operation writes them too. Exports without session edits are unchanged.
