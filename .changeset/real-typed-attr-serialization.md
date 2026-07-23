---
"@ifc-lite/export": patch
"@ifc-lite/parser": minor
"@ifc-lite/mutations": patch
---

Serialize whole numbers on REAL-typed STEP attributes with a decimal point.
`setPositionalAttribute`, `addEntity`, and the in-store builders' own emitted
geometry now consult the schema registry, so an integral value in a REAL-backed
slot (`IfcLengthMeasure` coordinates, profile dimensions, extrusion depth, …)
exports as `450.` rather than a bare `450` INTEGER literal that strict
validators (`ifcopenshell.validate`) reject. Integer-typed slots are left
untouched; the `{ real }` marker still works for genuinely ambiguous selects.
Positional names resolve across the schema union so IFC4X3-only alignment/civil
entities are covered too. Exposes `getAttributeNamesAcrossSchemas` from
`@ifc-lite/parser`.
