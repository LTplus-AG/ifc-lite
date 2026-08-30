---
'@ifc-lite/mcp': patch
---

Fix `count_entities({ group_by: 'material' })` and `materials_list` reporting every `IfcMaterialList`-associated entity as materialless.

`MaterialData.name` only exists for a plain `IfcMaterial` — an `IfcMaterialList` never carries a list-level name at all, only `.materials[]` with the individual material names. Both tools read `mat?.name` directly, so any entity whose material association resolved to an `IfcMaterialList` was silently bucketed as `'(no material)'` / `'(unnamed)'` instead of under its real material names, even though the same data is already surfaced correctly by `ifc-lite stats`'s `computeMaterialSummary` (`packages/cli/src/commands/stats-aggregation.ts`), which has always fallen back to the list's first member.

Both tools now go through a shared `materialDisplayName()` helper (`packages/mcp/src/tools/util.ts`) that falls back through `.materials[]`, `.layers[]`, `.profiles[]`, and `.constituents[]` in turn, matching the CLI's behaviour. Observable change: a `count_entities`/`materials_list` call against a model whose materials are assigned via `IfcMaterialList` now reports the real material names and counts instead of lumping those entities under the "no material" bucket.
