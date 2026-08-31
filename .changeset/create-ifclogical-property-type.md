---
'@ifc-lite/create': patch
---

`IfcCreator.addIfcPropertySet` no longer downgrades a boolean property declared `Type: 'IfcLogical'` to `IFCBOOLEAN`. `serializePropertyValue`'s boolean branch ignored `PropertyDef.Type` entirely and always emitted `IFCBOOLEAN(.T./.F.)`, so a caller asking for the tri-state `IfcLogical` measure (used throughout the standard IFC property sets, e.g. `Pset_LandRegistration.IsLandmarked`) got the two-state `IfcBoolean` type in the file instead — the value round-tripped correctly, but the declared property type did not match what was requested. `Type: 'IfcLogical'` now emits `IFCLOGICAL(.T./.F.)`; omitting `Type`, or passing `Type: 'IfcBoolean'`, is unchanged.
