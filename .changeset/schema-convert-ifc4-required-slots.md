---
"@ifc-lite/export": patch
---

Report the invalid IFC4 file that a schema downgrade from IFC4X3 or IFC5 produces when it leaves `$` in a slot IFC4 requires but the source schema made optional, such as `IfcProjectedCRS.Name` (#5202). The converter never invents a value there: no measure, label, identifier, reference, flag or enum. Instead `StepExporter` and `MergedExporter` now add a warning to `stats.warnings` counting those slots, so the caller can tell the file is not valid IFC4. The count comes from a table of IFC4-required slots generated from the EXPRESS-derived IFC4 registry. Enum-member reconciliation, the other gap #5202 reports, is tracked separately.
