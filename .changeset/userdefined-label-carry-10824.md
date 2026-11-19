---
"@ifc-lite/wasm": patch
"@ifc-lite/export": patch
---

Schema conversion keeps the label of a `.USERDEFINED.` type across IFC2X3 and IFC4/IFC4X3 (#10824). IFC2X3 holds it in `UserDefinedControlType` (IfcWorkPlan, IfcWorkSchedule), `UserDefinedProcedureType` (IfcProcedure) or `UserDefinedFunction` (IfcElectricDistributionPoint); IFC4 holds it in `ObjectType`. An upgrade writes it into an unset `ObjectType` instead of dropping it; a downgrade writes `ObjectType` into the unset IFC2X3 attribute, which IFC2X3's WHERE rule requires. A set `ObjectType` is kept and the IFC2X3 label is reported dropped, as before. IfcElectricDistributionPoint also converts in IfcElectricDistributionBoard's layout now, both ways (it kept ten attributes under the nine-attribute IFC4 type).
