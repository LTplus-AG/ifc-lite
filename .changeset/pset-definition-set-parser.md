---
"@ifc-lite/parser": patch
"@ifc-lite/create": patch
---

Property and quantity sets linked through `IfcRelDefinesByProperties.RelatingPropertyDefinition` written as the typed `IFCPROPERTYSETDEFINITIONSET((#20,#22))` are now read, so the viewer's property panel and IDS validation show them like the CSV, JSON and IFCX exports already do (#7681). The three spellings (a single reference, a bare set and the typed set) go through one reader, `readPropertyDefinitionRefs`, that agrees with the Rust one on a shared vector file; a set that repeats a member (`(#20,#20)`) no longer adds its relationship twice.
