---
"@ifc-lite/parser": minor
"@ifc-lite/create": patch
---

Property and quantity sets linked through `IfcRelDefinesByProperties.RelatingPropertyDefinition` written as the typed `IFCPROPERTYSETDEFINITIONSET((#20,#22))` are now read, so the viewer's property panel and IDS validation show them like the CSV, JSON and IFCX exports already do (#7681). `@ifc-lite/parser` exports `propertyDefinitionRefsOfValue`, the reader for an already decoded attribute 5 (a single reference, a bare set or the typed set); a set that repeats a member (`(#20,#20)`) no longer adds its relationship twice. Native current type quantities no longer become unavailable for a whole file because one relationship names a set. In `@ifc-lite/create`, duplicating an element now copies the property and quantity sets it is linked to through such a set, and keeps the set as `(#a,#b)` on the copy.
