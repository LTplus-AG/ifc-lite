---
"@ifc-lite/data": minor
"@ifc-lite/create": patch
"@ifc-lite/parser": patch
"@ifc-lite/cli": patch
"@ifc-lite/mcp": patch
---

`EntityTable.getTypeName()` returns the literal string `'Unknown'`, not `null`/`undefined`, for rows it can't resolve, so `getTypeName(id) || fallback` silently kept `'Unknown'` instead of falling back — breaking element duplication on imported models (#4933) among other call sites. Added `resolvedTypeName()` to `@ifc-lite/data` (returns `undefined` for the sentinel) and switched every affected lookup in `create`/`parser`/`cli`/`mcp` to use it.
