---
"@ifc-lite/export": patch
"@ifc-lite/mutations": patch
"@ifc-lite/data": patch
---

Type-qualify SELECT-typed and IfcValue-family STEP attributes on export. A
defined-type SELECT member (a boolean in an `IfcTranslationalStiffnessSelect`
slot, a length in `IfcSizeSelect`) now serializes as the ISO 10303-21 required
`IFCBOOLEAN(.T.)` / `IFCLENGTHMEASURE(3.)` rather than a bare `.T.` / `3` that
strict validators reject and that loses the member type on round-trip. The
exporter auto-qualifies unambiguous slots from the schema registry with no
caller change; a new write-only `{ typed: { type, value } }` marker on
`IfcAttributeValue` pins the type for ambiguous selects and the `IfcValue`
family (`NominalValue`, quantity values) and subsumes `{ real }`. Completes the
`setPositionalAttribute` / `addEntity` follow-up to #1839.
