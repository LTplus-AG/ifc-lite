---
'@ifc-lite/mcp': patch
---

Fix the `ifc-lite://model/{id}/materials` resource reporting every `IfcMaterialList`-associated entity as `'(unnamed)'`.

`MaterialData.name` only exists for a plain `IfcMaterial` (and, when authored in the source file, a LayerSet/ProfileSet/ConstituentSet) — an `IfcMaterialList` never carries a list-level name at all, only `.materials[]` with the individual material names. `MaterialsProvider.read` read `mat.name` directly, so any entity whose material association resolved to an `IfcMaterialList` was silently bucketed under `'(unnamed)'` instead of its real material name(s).

The resource now falls back through `.materials[]`, `.layers[]`, `.profiles[]`, and `.constituents[]` in turn. The CLI's `computeMaterialSummary` (`packages/cli/src/commands/stats-aggregation.ts`) already resolves the `IfcMaterialList` case from `.materials[0]`; the layer, profile and constituent fallbacks here go beyond what it does. Observable change: reading the `materials` resource for a model whose materials are assigned via `IfcMaterialList` (or an unnamed LayerSet/ProfileSet/ConstituentSet) now reports the real material names and counts instead of lumping those entities under `'(unnamed)'`.

Note: this mirrors the same fix proposed for `count_entities`/`materials_list` in #3515 (open at the time of this patch). Once that PR's shared `materialDisplayName()` helper (`packages/mcp/src/tools/util.ts`) lands, this resource's local fallback should be replaced with it rather than kept as a second copy of the same logic.
