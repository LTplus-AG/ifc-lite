---
'@ifc-lite/data': minor
'@ifc-lite/parser': minor
'@ifc-lite/sdk': minor
'@ifc-lite/mcp': minor
'@ifc-lite/cache': patch
---

Index every schema-resolvable `IfcRelationship` subtype as an exact typed edge, expose exact inbound/outbound relationship rows through the SDK, MCP, and viewer, and allow `related()` queries for every indexed `IfcRel*` name. Bump the cache format so graphs cached before the expanded indexing are reparsed instead of silently omitting the new edge buckets. `@ifc-lite/parser` also exports `resolveEffectiveEntityRecord`, the one place a read model folds a queued retype (name-based re-layout), named and positional edits into an entity record exactly as export writes it; the CLI, MCP and viewer read surfaces use it.
