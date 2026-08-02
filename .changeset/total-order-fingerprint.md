---
'@ifc-lite/diff': patch
---

**diff**: make the canonical sorts a total order, so `dataHash` cannot depend on the order an adapter walked its relationships.

`sortedEntries`, `sortedPropertySets` and `sortedQuantitySets` ordered records by `name` alone. `Array.prototype.sort` is stable, so two records sharing a name kept their *input* order — and the sorted result is serialized and hashed, so the same content supplied in two orders produced two different fingerprints. Same-named property sets are an ordinary IFC arrangement (a type pset and an occurrence pset of one name), so this was reachable, not theoretical.

Records now tiebreak on their own serialized content. Fingerprint values change only for entities that actually carry same-named collections; everything else is byte-identical.
