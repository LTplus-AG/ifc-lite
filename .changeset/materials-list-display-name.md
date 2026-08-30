---
'@ifc-lite/mcp': minor
---

Fix `count_entities({ group_by: 'material' })` and `materials_list` reporting every `IfcMaterialList`-associated entity as materialless.

A `MaterialData` of type `MaterialList` carries no `name` at all — the individual material names live under `.materials[]`. Both tools read `mat?.name` directly, so any entity whose material association resolved to an `IfcMaterialList` was silently bucketed as `'(no material)'` / `'(unnamed)'` instead of under its real material names, even though `ifc-lite stats`'s `computeMaterialSummary` (`packages/cli/src/commands/stats-aggregation.ts`) already resolves that case from the list's first member.

Both tools now go through a shared `materialDisplayName()` helper (`packages/mcp/src/tools/util.ts`) that falls back through `.materials[]`, `.layers[]`, `.profiles[]`, and `.constituents[]` in turn. Only the `.materials[]` leg matches the CLI, and the CLI checks it before `.name` rather than after; the other three legs go beyond `computeMaterialSummary`, which names a layer/profile/constituent set only when the set itself is named.

Observable change: a `count_entities`/`materials_list` call against a model whose materials are assigned via `IfcMaterialList` now reports the real material names and counts instead of lumping those entities under the "no material" bucket. Callers that read those group keys see different keys and different counts for such models, which is why this is a minor rather than a patch.
