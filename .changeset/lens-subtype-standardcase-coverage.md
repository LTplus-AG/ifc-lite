---
"@ifc-lite/lens": patch
---

`IFC_SUBTYPE_TO_BASE`, the map `matchesIfcType` uses so a lens rule against a base type (e.g. `IfcDoor`) also matches its StandardCase variant, only covered 4 of IFC4's 9 `*StandardCase` entities (Wall/Slab/Column/Beam). Door, Window, Member, Plate, and Opening were missing, so a rule written against those base types silently failed to match entities exported as the StandardCase variant — no error, the entity was just left unmatched and ghosted. The map now covers every `*StandardCase` entity across IFC2X3/IFC4/IFC4X3, guarded by a schema-parity test that re-derives the set from the generated entity tables.
