---
'@ifc-lite/mcp': patch
---

Fix `viewer_get_selection`'s text summary silently dropping the "Materials:" line for a selected entity whose material association resolves to an unnamed `IfcMaterialProfileSet` or `IfcMaterialConstituentSet`.

The formatting chain in `viewer.ts` checked `.layers[]` and `.materials[]` (the `IfcMaterialList` case fixed for the `materials` resource in #3519) before falling back to a single `mat.name ?? mat.materialName` check. A `MaterialProfileSet`/`ConstituentSet` with no set-level `Name` has neither of those, so the whole line disappeared instead of naming the member material(s) — worse than the `IfcMaterialList` case, which at least listed member names.

Extracted the formatting into a new sibling module (`packages/mcp/src/tools/material-summary.ts`, `viewer.ts` sits at its module-size budget) that lists every multi-material shape (`.layers[]`, `.profiles[]`, `.constituents[]`, `.materials[]`) by member name, falling back to the set-level `Name` when the members name nothing at all (`IfcMaterialProfile.Material` is optional, so an all-unnamed set is valid IFC and its `Name` says more than a row of `?` placeholders), and reusing a new shared `materialFallbackName()` helper (`packages/mcp/src/material-naming.ts`, lifted out of `providers.ts`'s local copy from #3519) for that last fallback. Once #3515's proposed `materialDisplayName()` lands in `packages/mcp/src/tools/util.ts`, this local helper should be replaced with it.
