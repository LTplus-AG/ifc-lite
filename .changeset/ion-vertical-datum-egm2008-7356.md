---
"@ifc-lite/export": minor
---

Add the opt-in `normalizeVerticalDatumToEgm2008` STEP export option. It writes a free-text `IfcProjectedCRS.VerticalDatum` naming a sea-level datum (for example `EVRS2007`) as `EPSG:3855` (EGM2008 height), the geoid Cesium ion applies. Without it, ion placed such models one geoid separation too low (48 m for a public alignment bridge). Explicit EPSG codes and ellipsoidal datum names are preserved, and heights are never rewritten.
