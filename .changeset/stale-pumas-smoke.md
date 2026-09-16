---
"@ifc-lite/create": minor
"@ifc-lite/sandbox": minor
---

Author IFC 5D cost data from scratch. `IfcCreator` gains exact-name methods for
`IfcCostSchedule`, `IfcCostItem`, `IfcCostValue`, the `IfcMonetaryUnit` /
`IfcSIUnit` / `IfcMeasureWithUnit` a rate is quoted in, standalone
`IfcPhysicalSimpleQuantity` values, and the nesting / schedule / product / task
relationships that bind them, all backed by one shared builder
(`ifc-creator-cost.ts`) and exposed through `bim.create.*`. A new
`ProjectParams.Currency` writes the project `IfcMonetaryUnit`.

Written to be read back by the cost read model added in #4863: values that carry
a literal amount are serialized as named SELECT branches
(`IFCMONETARYMEASURE(1234.56)`), never as bare numbers, while
`IfcQuantityArea.AreaValue` and its siblings stay bare because they are defined
types rather than SELECTs. `UnitBasis` is preserved as the real per-quantity
divisor it is, a shared measure entity is written once and referenced, and a
value derived from `Components` is not normalised into a literal (or the
reverse).

Absent stays absent. There is no default currency — a model authored without one
reads back with none rather than a guess — and an omitted list attribute is
written as absent while an EMPTY array is refused, because the two are different
answers. Cost authoring is refused explicitly under IFC2X3, where the entities
have a different attribute layout, rather than silently writing nothing.

A fractional `IfcQuantityCount` value is refused rather than silently rounded:
`IfcQuantityCount.CountValue` is stored as an unparsed string on read, so a
rounded count would round-trip altered with no trace of the change.
