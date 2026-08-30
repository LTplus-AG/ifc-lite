---
'@ifc-lite/viewer': patch
---

Fix the LLM context builder (`context-builder.ts`) silently reporting no material for a selected/typed entity whose material association resolves to an unnamed `IfcMaterialLayerSet`, `IfcMaterialProfileSet`, or `IfcMaterialConstituentSet`.

`materialName` was computed as `rawMaterial?.name ?? rawMaterial?.materials?.[0]?.name` — a set-level name, then the first `IfcMaterialList` member. Neither leg reads `.layers[]`, `.profiles[]`, or `.constituents[]`, so a set with no set-level `Name` (common: those sets are frequently authored unnamed, with the name carried only on the layer/profile/constituent) reported `materialName: undefined` — the LLM's system-prompt context then had no material at all for that element, even though one was assigned.

Extracted the lookup into a new sibling module (`apps/viewer/src/lib/llm/material-name.ts`) exporting `materialDisplayName()`, which falls back through `.materials[]` → `.layers[]` → `.profiles[]` → `.constituents[]`, matching the same fallback chain fixed for the MCP `materials` resource in #3519.
