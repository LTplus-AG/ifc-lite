---
"@ifc-lite/mutations": patch
---

Fix `MutablePropertyView.setProperty`/`deleteProperty` and `setQuantity` mutating an existing property or quantity on EVERY base property/quantity set sharing a name, instead of only the first one that carries it. An entity that carries two same-named psets or qsets (a type set and an occurrence set, say) both holding a `FireRating` property or a `Width` quantity now has edits and deletes land on the first same-named instance only, matching the first-match-wins semantics `getPropertyValue`/`PropertyTable.getProperty` already use for reads. `getForEntity`/`getQuantitiesForEntity` are the single source of truth the STEP exporter reads from, so no separate export-side fix was needed.
