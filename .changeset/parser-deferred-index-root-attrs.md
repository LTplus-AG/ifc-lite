---
"@ifc-lite/parser": patch
---

`extractEntityAttributesOnDemand` now finds entities that are only in the deferred entity index, so their GlobalId, Name, Description, ObjectType, Tag and LongName are no longer empty.
