---
"@ifc-lite/mutations": patch
---

Fix `MutablePropertyView.setProperty`/`deleteProperty` mutating an existing property on EVERY base property set sharing a name, instead of only the first one that carries it. An entity that carries two same-named psets (a type pset and an occurrence pset, say) both holding a `FireRating` property now has edits and deletes land on the first same-named instance only, matching the first-match-wins semantics `getPropertyValue`/`PropertyTable.getProperty` already use for reads. `MutablePropertyView.getForEntity` is the single source of truth the STEP exporter reads from, so no separate export-side fix was needed.
