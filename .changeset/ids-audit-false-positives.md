---
"@ifc-lite/ids": patch
---

`auditIDSDocument` no longer reports errors on conforming IDS documents that use user-defined predefined types (any value is valid when the entity's enum has `USERDEFINED`; it is matched against `ObjectType` / `ElementType` / `ProcessType`), IFC2X3 entities from the IDS occurrence/type mapping table (such as `IFCAIRTERMINAL`, checked through `IfcAirTerminalType`), or a classification on an IFC4 resource such as `IfcMaterial`. Every pass and fail case of the buildingSMART IDS corpus now audits without errors (18 did not).
