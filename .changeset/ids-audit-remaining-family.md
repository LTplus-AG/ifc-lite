---
"@ifc-lite/ids": patch
---

`auditIDSDocument` reports a prohibited specification (`maxOccurs="0"`) that has requirements (`E_CARDINALITY_INVALID`), and a `predefinedType` on an entity that has no PredefinedType in that IFC version, neither on itself nor on its type object, such as IFC2X3's `IfcInventory` (`E_IFC_PREDEF_TYPE_INVALID`; IFC2X3 occurrences like `IfcWall` are checked against their type object's predefined types). The audit now rejects all 27 `invalid-` cases of the buildingSMART IDS corpus and reports no error on any of its 307 pass and fail cases.
