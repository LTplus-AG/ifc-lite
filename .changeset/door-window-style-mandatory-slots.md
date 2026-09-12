---
"@ifc-lite/export": patch
---

Downgrading an `IfcDoorType` or `IfcWindowType` to IFC2X3 no longer writes `$` into the `IfcDoorStyle`/`IfcWindowStyle` attributes IFC2X3 requires. `OperationType` and `ConstructionType` get `.NOTDEFINED.` and `ParameterTakesPrecedence` and `Sizeable` get `.F.` when the IFC4 source has no value for them, instead of a `$` a strict reader rejects in those slots. Optional slots still get `$`. The Rust exporter follows the same rule.
