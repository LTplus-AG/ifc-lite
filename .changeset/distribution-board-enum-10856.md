---
"@ifc-lite/wasm": patch
"@ifc-lite/export": patch
---

The Rust exporter reconciles enum members in the slots of a renamed type, as the TypeScript one already did (#10856). An IfcElectricDistributionPoint function the IFC4 board enum lacks (`.ALARMPANEL.`) becomes `.USERDEFINED.` with its name in `ObjectType`, and an IFC4X3 board member IFC2X3 lacks becomes `.USERDEFINED.` with its name in `UserDefinedFunction`. In both exporters the enum policy now finds a label IFC2X3 names by the end of the enum attribute, so IFC4 `IfcDerivedUnit` and `IfcObjective` members IFC2X3 lacks keep their names in `UserDefinedType` and `UserDefinedQualifier` instead of being refused or written as `.NOTDEFINED.`.
