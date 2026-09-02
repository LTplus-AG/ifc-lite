---
'@ifc-lite/ids': patch
---

Fix `auditIDSDocument` silently accepting `cardinality="optional"` on a `<partOf>` requirement. `ids.xsd` 1.0 types `<partOf>`'s `@cardinality` as `ids:simpleCardinality` (`{required, prohibited}`), unlike every other requirement facet's three-value `ids:conditionalCardinality`, so `optional` never tripped the coherence audit's generic "not a valid value" check — it is one of the three canonical tokens, just not one this facet accepts. A hand-authored IDS document using it now gets an `E_CARDINALITY_INVALID` finding from `auditIDSDocument`, matching what buildingSMART's own schema rejects.
