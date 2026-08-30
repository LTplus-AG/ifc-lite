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
- MCP and CLI entity queries with a property filter (`query_entities`, `ifc-lite query --where`) could wrongly exclude a matching entity from the results, with no indication anything was omitted, when the filtered property lived ONLY on the entity's second same-named property set. (When both sets carry it, the filter still reads the first one's value -- see the closing paragraph.)
- CSV/JSON export with a `Pset.Property` or `Qto.Quantity` column could emit an empty cell instead of the real value, for the same reason.
- The viewer's advanced-filter query could likewise drop a matching entity from the result count/highlight.
- `ifc-lite query`'s `--sort`, `--group-by` and `--unique` on a `Pset.Property` path, and `ifc-lite export`'s dotted columns, read only the first same-named set and so sorted, grouped, or exported a blank where a value existed.
- Editing a quantity whose base value lived on a second same-named quantity set recorded the wrong "old value" and the wrong create-vs-update classification, which undo relied on.
- Deleting a property or quantity set that the entity carried twice under the same name removed only the first one's members: the panel showed the whole set gone while the exported file still carried the second one's properties.

All of these now scan every same-named set, not just the first, before deciding a property or quantity is absent.

Which member they then use is still first-match, and that is the remaining gap: when two same-named sets both carry the property, only the first one's value is read. Emitting one cell wants exactly that, but a filter does not -- `ifc-lite query --where Pset_WallCommon.FireRating=REI60` still drops a wall whose first `Pset_WallCommon` says `REI30` and whose second says `REI60`. That behaviour predates this change and is tracked in #3490.
