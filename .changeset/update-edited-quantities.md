---
"@ifc-lite/create": minor
"@ifc-lite/export": minor
"@ifc-lite/mutations": minor
"@ifc-lite/viewer": minor
---

New opt-in viewer setting, "Update quantities of edited elements" (#9026). It is off by default and saved in the browser. You can turn it on in Settings → General or on the Quantities tab. When it is on, changing the shape of a loaded wall, slab, roof, column or beam recomputes that element's base quantity set from its new geometry. The same derivation that authored elements use does the work. The Properties and Measure panels show the new values, the STEP export writes them, and the refreshed set is labelled "Updated from geometry". When it is off, loaded files read and export as before.

A refresh only replaces a `Qto_*BaseQuantities` (or IFC2X3 `BaseQuantities`) set the file already has. It never adds one. If you edit or delete a quantity yourself, your edit still wins, and undo takes back the refresh along with the edit.

New API:
- `@ifc-lite/create` exports `withRefreshedBaseQuantities`, `refreshedBaseQuantitySet`, `refreshedBaseQuantitySets` and `hasRefreshableBaseQuantities`.
- `@ifc-lite/mutations` adds `MutablePropertyView.setQuantityBaseRevisions` / `getQuantityBaseRevisions` and the `QuantityBaseRevision` type. A view's quantity base uses them to name the sets it reads differently from the file.
- `@ifc-lite/export` writes the named sets the same way it writes an edited set.
