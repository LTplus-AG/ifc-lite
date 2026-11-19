---
"@ifc-lite/sdk": minor
---

Add the `@ifc-lite/sdk/georef-doctor` subpath: `collectGeorefFacts`, `checkGeorefFacts` (the `bim.georef.check()` diagnosis over facts the caller holds, so a host can lay its own unsaved georeference edits over the file's) and `planGeorefFixes` (the `bim.georef.planFixes()` safety rules), for hosts that load the checker lazily. The viewer's Georeference panel uses it (#10608).
