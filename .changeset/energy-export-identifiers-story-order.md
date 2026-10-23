---
"@ifc-lite/wasm": patch
---

HBJSON and DFJSON exports now load in Honeybee and Dragonfly in three cases that they used to refuse or get wrong.

- Every identifier matches the honeybee-schema / dragonfly-schema pattern `^[.A-Za-z0-9_-]+$` and is at most 100 characters. A model name or material name with non-ASCII letters (`Dämmung`, `Bürogebäude`) used to be passed through, which the schemas refuse. `.` and `-` are now kept, as Honeybee keeps them, so `Tower.v2` stays `Tower.v2`. Long names are cut to 100 characters with the thickness suffix kept, and two materials whose names only differ after that point keep separate identifiers. The model's `display_name` now keeps the name exactly as you passed it.
- An `IfcSpace` modelled as several extruded items exports one room per item, named `R<id>`, `R<id>_1`, and so on. It used to emit every item as `R<id>`, and duplicate room identifiers make the whole model fail to load.
- DFJSON stories are ordered by their rooms' floor heights. In a millimetre file, a storey with no declared `Elevation` used to be placed below storeys it sits above, which put the ground-contact, roof-exposure and floor-to-floor values on the wrong stories.
