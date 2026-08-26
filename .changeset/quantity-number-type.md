---
"@ifc-lite/data": patch
"@ifc-lite/parser": patch
"@ifc-lite/export": patch
"@ifc-lite/ids": patch
---

Recognise `IfcQuantityNumber` instead of relabelling it as a count

IFC4X3 added `IfcQuantityNumber` to the `IfcPhysicalSimpleQuantity` family,
but `QuantityType` stopped at `Time`, so the parser's lookup fell through to
its `?? QuantityType.Count` default. The value survived; the type did not. A
`Number` quantity was exported to Parquet as `Count`, described to IDS as
`IFCCOUNTMEASURE`, and written back out by the STEP exporter as
`IFCQUANTITYCOUNT` — a silent entity rewrite on round-trip.

`QuantityType.Number` now exists and the parser, the Parquet and STEP
exporters, the IDS data-type bridge and the viewer's unit table all carry it.
A schema-derived test in `@ifc-lite/data` asserts the enum against the
generated per-version entity tables in both directions, so the next subtype a
schema regeneration introduces reds rather than falling through.
