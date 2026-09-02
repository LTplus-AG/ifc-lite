---
'@ifc-lite/mcp': patch
---

Fix `bcf_topic_list`'s `status` filter using an exact, case-sensitive match against `topicStatus`. BCF status strings are conventionally Title Case (`'Open'`, `'Closed'`), but nothing tells a calling agent that, and a differently-cased filter (e.g. `'open'`) silently returned zero topics — indistinguishable from "there really are none". `@ifc-lite/bcf`'s own `computeMarkers3D` already lowercases both sides for its status filter; `bcf_topic_list` now matches that.
