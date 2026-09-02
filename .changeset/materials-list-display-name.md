---
'@ifc-lite/mcp': minor
---

Fix `count_entities({ group_by: 'material' })` and `materials_list` reporting every `IfcMaterialList`-associated entity as materialless.

A `MaterialData` of type `MaterialList` carries no `name` at all — the individual material names live under `.materials[]`. Both tools read `mat?.name` directly, so any entity whose material association resolved to an `IfcMaterialList` was silently bucketed as `'(no material)'` / `'(unnamed)'` instead of under a real material name, even though `ifc-lite stats`'s `computeMaterialSummary` (`packages/cli/src/commands/stats-aggregation.ts`) already resolves that case from the list's first member.

Both tools now go through a shared `materialDisplayName()` helper (`packages/mcp/src/tools/util.ts`) that falls back through `.materials[]`, `.layers[]`, `.profiles[]`, and `.constituents[]` in turn. Only the `.materials[]` leg matches the CLI, and the CLI checks it before `.name` rather than after; the other three legs go beyond `computeMaterialSummary`, which names a layer/profile/constituent set only when the set itself is named.

The `ifc-lite://model/{id}/materials` resource, fixed one patch earlier with a private copy of the same fallback chain, now imports this helper and drops that copy. The two function bodies were byte-identical, so the resource's output does not change; what changes is that there is one implementation left to keep correct instead of two that nothing compared.

Observable change: `count_entities` and `materials_list` now report a real material name for an entity whose material is an `IfcMaterialList`, or an `IfcMaterialLayerSet` / `IfcMaterialProfileSet` / `IfcMaterialConstituentSet` that carries no set-level name of its own. All of those previously landed in the `'(no material)'` / `'(unnamed)'` bucket, so callers reading the group keys see different keys and different counts for such models.

The fallback picks one name per entity, not all of them: for an `IfcMaterialList` holding several materials it reports the first member only, as the CLI does. A model that assigns a multi-material list therefore still under-reports how many distinct materials are in use, and this fix does not change that.
