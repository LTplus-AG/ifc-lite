---
'@ifc-lite/query': minor
'@ifc-lite/mcp': patch
'@ifc-lite/sdk': patch
'@ifc-lite/cli': patch
'@ifc-lite/mutations': patch
'@ifc-lite/viewer': patch
---

Fix queries, filters, and CSV/JSON exports that silently dropped or omitted data when an entity carried two property (or quantity) sets with the same name -- e.g. one from the type definition and one from the occurrence, which is valid IFC.

Affected symptoms, now fixed:
- MCP and CLI entity queries with a property filter (`where_property` / `query_entities` filters) could wrongly exclude a matching entity from the results, with no indication anything was omitted, if the filtered property lived on the entity's second same-named property set.
- CSV/JSON export with a `Pset.Property` or `Qto.Quantity` column could emit an empty cell instead of the real value, for the same reason.
- The viewer's advanced-filter query could likewise drop a matching entity from the result count/highlight.
- Editing a quantity whose base value lived on a second same-named quantity set recorded the wrong "old value" and the wrong create-vs-update classification, which undo relied on.

All of these now check every same-named set, not just the first, before deciding a property or quantity is absent.
