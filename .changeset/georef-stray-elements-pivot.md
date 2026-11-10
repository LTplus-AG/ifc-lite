---
"@ifc-lite/viewer": patch
---

A georeferenced model with a few stray elements far away from the building now lands at its map position in the World view. Some Vectorworks exports place provision-for-void proxies absolutely, with site-local numbers, which puts them about 6000 km from a building placed at its UTM site. The model's bounding box stretched to reach them, its centre fell in the mid-Atlantic, the map-absolute (#2526) guard missed, and the whole model was drawn over the sea. The georeference now pivots on the RTC origin (the median element placement) when the box centre lies more than 10 km from it, so the building lands where its stray-free subset does.
