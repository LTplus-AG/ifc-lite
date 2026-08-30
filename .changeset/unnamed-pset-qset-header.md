---
'@ifc-lite/viewer': patch
---

Fix the properties panel rendering a blank group header for a property set or quantity set whose IFC `Name` is empty.

`IfcRoot.Name` is optional, so a real STEP file can declare an `IFCPROPERTYSET`/`IFCELEMENTQUANTITY` with `Name` as the empty string literal `''` — `extractPsetsFromIds` in `packages/parser` only fabricates a placeholder when `Name` is the null marker `$` (not a string at all), so a declared `''` already passes through to the panel today, before PR #3534. `PropertySetCard` and `QuantitySetCard` rendered that name verbatim, collapsing the group header to just the count badge with no visible label.

Both cards now route the header through a new `setDisplayName(name, kind)` helper (`apps/viewer/src/components/viewer/properties/setDisplayName.ts`), falling back to `Unnamed Property Set` / `Unnamed Quantity Set` when the name is empty. Neither card receives an id to build a fallback from — the viewer's `PropertySet`/`QuantitySet` prop shapes declare no id field — so unlike `treeDataBuilder`'s `getName || "<Type> #<id>"` convention for element rows, the fallback here names only the kind. A named set still renders its real name unchanged.
