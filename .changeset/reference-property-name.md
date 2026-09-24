---
"@ifc-lite/parser": patch
"@ifc-lite/rules": patch
---

An `IfcPropertyReferenceValue` now reads as the `Name` of the object it references (a material, person, document, classification reference, …). If the object has no `Name`, it reads as its `Identification`, and failing that as `#<id>`. The parser used to take the `UsageName` slot for the reference, so every reference property read as empty. That was a bug, and rules and the property panel now see the referenced name. It also applies to references nested inside a complex property.
