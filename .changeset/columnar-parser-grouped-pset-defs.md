---
'@ifc-lite/parser': patch
---

Fix `extractPropertyRelFast` silently dropping `IfcRelDefinesByProperties` relationships whose `RelatingPropertyDefinition` is a grouped `IfcPropertySetDefinitionSet` instead of a single property/quantity set reference.

`RelatingPropertyDefinition` is typed `IfcPropertySetDefinitionSelect`, whose
second alternative (`IfcPropertySetDefinitionSet`, a `SET [1:?] OF
IfcPropertySetDefinition`) is schema-legal in both bundled IFC4 and IFC4X3
schemas and is written as a parenthesised ref list, e.g. `(#20,#21)`, not a
bare `#20`. The byte-level scanner read this attribute with `readRefId`,
which only recognises a bare `#id`; on the list form it saw the opening `(`
instead of `#`, returned `-1`, and the whole relationship was discarded --
every related object in the `RelatedObjects` set silently lost all
properties and quantities from that pset group, with no error surfaced.

`extractPropertyRelFast` now reads the attribute with `readRefList`, which
already accepts both a bare ref and a parenthesised list, and returns
`relatingDefs: number[]` instead of a single `relatingDef: number`. The two
other consumers of this shared scanner (`IfcRelAssociatesMaterial` /
`...Classification` / `...Document`) are unaffected: none of their
`Relating*` selects admit a SET alternative, so they always see a
length-1 list.
