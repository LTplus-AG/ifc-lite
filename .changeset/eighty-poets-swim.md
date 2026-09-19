---
'@ifc-lite/data': minor
'@ifc-lite/parser': minor
'@ifc-lite/sdk': minor
'@ifc-lite/mcp': minor
'@ifc-lite/cache': patch
---

Index every schema-resolvable `IfcRelationship` subtype as an exact typed edge, expose exact inbound/outbound relationship rows through the SDK, MCP, and viewer, and allow `related()` queries for every indexed `IfcRel*` name. Bump the cache format so graphs cached before the expanded indexing are reparsed instead of silently omitting the new edge buckets.
