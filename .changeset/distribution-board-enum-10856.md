---
"@ifc-lite/wasm": patch
"@ifc-lite/export": patch
---

The Rust exporter reconciles enum members in the slots of a renamed type, as the TypeScript one already did (#10856). An IfcElectricDistributionPoint function the IFC4 board enum lacks (`.ALARMPANEL.`) becomes `.USERDEFINED.` with its name in `ObjectType`, and an IFC4X3 board member IFC2X3 lacks becomes `.NOTDEFINED.` and is reported. The enum reconciliation table now covers every enum slot of the types a conversion renames records into. In both exporters the `.USERDEFINED.` label carry runs after enum reconciliation.
