---
'@ifc-lite/viewer': patch
---

Lists Area and Volume columns now scale by LENGTHUNIT squared and cubed when the file declares no explicit `AREAUNIT`/`VOLUMEUNIT`, which is what IFC means by omitting them. A millimetre-authored 2m x 3m slab reported `6,000,000 m²` and now reports `6 m²`. Models that do declare an explicit unit are unaffected.

The zone "Volume (mesh)" column derives its scale on a separate path (`ListPanel`), and that path gets the same fallback through the new `zoneVolumeSiScale` helper. Without it the two disagreed by the length factor cubed and a 30 m³ zone in a millimetre model displayed as `3e-8 m³`.
