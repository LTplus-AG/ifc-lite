---
"@ifc-lite/create": minor
---

Numeric property values are now written as the measure type they declare. `addIfcPropertySet` used to emit every number as `IFCREAL` or `IFCINTEGER` whatever `Type` said, so a `ThermalTransmittance` declared `IfcThermalTransmittanceMeasure` came out `IFCREAL(0.25)` and failed IDS data-type checks against `Pset_WallCommon`. `PropertyType` now accepts any `Ifc…Measure` (new `PropertyMeasureType`); a whole `IfcCountMeasure` is written as an integer, and a type name that is not a bare IFC identifier is refused instead of being spliced into the STEP line.
