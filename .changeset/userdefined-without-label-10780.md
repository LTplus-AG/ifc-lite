---
"@ifc-lite/export": patch
"@ifc-lite/wasm": patch
---

Schema conversion reports a record written with PredefinedType `.USERDEFINED.` and its label attribute (`ObjectType`, `ElementType`, `ProcessType` or `ResourceType`) unset, which the target schema's USERDEFINED rule rejects (#10780): for example an IFC2X3 IfcWorkPlan upgraded to IFC4. The converter does not invent a label. Both exporters add a warning ("N record(s) say PredefinedType .USERDEFINED. without the label their rule needs") naming the types; the Rust exporter counts the records in `enum_values_refused`. The rule set is derived from the EXPRESS WHERE rules of IFC2X3, IFC4 and IFC4X3.
