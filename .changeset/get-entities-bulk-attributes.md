---
'@ifc-lite/mcp': patch
---

Fix `get_entities_bulk` silently ignoring `include: ['attributes']` (its own documented default): the handler checked `include` for `properties`/`quantities`/`classifications`/`materials` but never `attributes`, so the full EXPRESS attribute list `get_entity` attaches for the same request never appeared in the bulk response — no error, just a quietly incomplete payload.
