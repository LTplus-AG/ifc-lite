---
"@ifc-lite/wasm": patch
"@ifc-lite/export": patch
---

Schema conversion no longer writes a value the target slot's type cannot hold (#10847). An attribute that keeps its name across IFC2X3, IFC4 and IFC4X3 can change type. An IFC2X3 `IfcCalendarDate` reference in IFC4 `IfcClassification.EditionDate`, an `IfcTimeMeasure` number in an `IfcDuration` slot, or an IFC4 `IFCDATE(...)` property value in IFC2X3 is now written as `$`, counted as dropped and named in the export warnings. Values that convert without loss are converted: an IFC4 `IfcParameterValue` is wrapped for IFC4X3's `IfcCurveMeasureSelect` and unwrapped back, and an integral count becomes an IFC4X3 INTEGER. `docs/architecture/schema-value-forms.md` lists every affected slot.
