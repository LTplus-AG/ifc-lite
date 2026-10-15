---
"@ifc-lite/wasm": patch
---

The CSV, JSON, JSON-LD and IFCX data exports now keep property and quantity sets linked through an IFC4 `IfcPropertySetDefinitionSet`, whether written as a list `(#20,#22)` or as `IFCPROPERTYSETDEFINITIONSET((#20,#22))`; before, every set attached that way was dropped (#7681). JSON, JSON-LD and IFCX now keep every numeric property a number, including measures such as `IfcThermalTransmittanceMeasure` and `IfcPlaneAngleMeasure` that were exported as strings. A flattened CSV column whose `Pset_Prop` name collides with another (`Pset_A` + `B_C` and `Pset_A_B` + `C`) gets a ` (2)` suffix instead of sharing the header.
