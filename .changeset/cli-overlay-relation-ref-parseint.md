---
'@ifc-lite/cli': patch
---

`HeadlessBackend.query.related()` no longer resolves a malformed `IfcRel…` reference to a real entity id (#3502). The overlay's `'#42'` reference parser used `Number.parseInt`, which stops at the first non-digit character, so a relating/related end authored as `#42junk` or `#42.5` on a queued relationship resolved to express id `42` instead of being rejected. It now requires a full `/^#(\d+)$/` match and a `Number.isSafeInteger` id, so a malformed or out-of-range reference (past `Number.MAX_SAFE_INTEGER`) resolves to nothing.
