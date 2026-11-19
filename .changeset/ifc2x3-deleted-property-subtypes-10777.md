---
"@ifc-lite/export": patch
---

An IFC2X3 -> IFC4/IFC4X3 conversion writes the property subtypes IFC4 deleted as their IFC4 supertype (#10777): `IfcExtendedMaterialProperties` and the typed material properties (mechanical, thermal, hygroscopic, general, optical, water, fuel, products of combustion) as `IfcMaterialProperties`, and `IfcGeneralProfileProperties`, `IfcStructuralProfileProperties`, `IfcStructuralSteelProfileProperties` and `IfcRibPlateProfileProperties` as `IfcProfileProperties`. Before, they kept their IFC2X3 names, which IFC4 readers cannot read. The typed subtypes keep only `Material` or `ProfileDefinition`; every measure is reported dropped by name, and the required `Properties` left `$` is counted.
