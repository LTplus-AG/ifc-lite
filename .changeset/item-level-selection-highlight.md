---
"@ifc-lite/renderer": minor
---

Add `RenderOptions.selectedItemId` (#4382, a follow-up to #2985/#3526/#3528): narrows `selectedId`'s highlight to a single representation item within the product, instead of the whole product.

The renderer hydrates and highlights only the flat or GPU-instanced mesh pieces whose `geometryItemId` matches — the same id a pick already reports via `PickResult.geometryItemId`. Switching `selectedItemId` while `selectedId` stays the same (choosing another item within one still-selected product) disposes the stale item's hydrated piece and instanced selected flag before applying the new one, so the highlight replaces cleanly instead of accumulating. `selectedItemId` has no effect without `selectedId`, and only ever narrows `selectedId`'s own product: every OTHER product in `selectedIds` stays whole-product, matching rect/marquee select. If `selectedId`'s product also happens to be a member of `selectedIds` (e.g. it is the anchor of an extended multi-select), that one product is narrowed too — the filter tracks `selectedId`, not membership in `selectedIds`.
