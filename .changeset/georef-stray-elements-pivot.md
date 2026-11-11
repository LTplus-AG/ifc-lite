---
"@ifc-lite/viewer": patch
---

A georeferenced model with a few stray elements far from the building now lands at its map position in the World view when loaded in the browser. Some Vectorworks exports place provision-for-void proxies absolutely, with site-local numbers, so they sit at the file's own origin, about 6000 km from a building placed at its UTM site. The bounding box stretched to reach them, its centre fell in the mid-Atlantic, the map-absolute (#2526) guard missed, and the whole model was drawn over the sea. When the box reaches both the RTC origin (the median element placement) and the file's own origin, the georeference now pivots on the RTC origin, so the building lands where its stray-free subset does.
