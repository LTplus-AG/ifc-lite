---
"@ifc-lite/parser": minor
---

Add a cost (5D) read model and on-demand extractor: `extractCostOnDemand` parses `IfcCostItem`, `IfcCostValue`, `IfcCostSchedule`, `IfcRelNests` (cost item breakdown) and `IfcRelAssignsToControl` (cost-schedule-to-cost-item and cost-item-to-product assignment) into a normalized `CostExtraction`. `CostItemInfo.costQuantities` resolves `CostQuantities` in place via the shared `collectQuantitiesFromRefs` walk and never falls back to a product's `Qto_` quantity sets, so a cost estimator's deliberately adjusted quantity is never silently overwritten by the geometry-derived one. IFC2X3 (whose `IfcCostItem` carries no attributes at all) is handled explicitly rather than assumed compatible with IFC4/IFC4X3.

`CostValueInfo` now also carries `unitBasis` (`IfcAppliedValue.UnitBasis`, schema slot 3), resolved to a `{ valueComponent, unitSymbol, unitSiScale }` triple via the existing unit-resolution machinery in `project-units.ts`. `UnitBasis` is what distinguishes a rate ("$85 per hour") from a flat total ("$5,000") — without it, two cost values with the same `appliedValue` are indistinguishable, so a naive summing consumer would silently treat a unit price as a total. `unitBasis` is `undefined` when `UnitBasis` itself is absent or its reference does not resolve, matching this module's existing absent-vs-unresolved convention (`costValues`, `parentGlobalId`); the `valueComponent`/`unitSymbol` sub-fields are each individually `undefined` when that half of `IfcMeasureWithUnit` could not be resolved (e.g. an `IfcContextDependentUnit`, which carries no SI conversion) without discarding the rest of the record.

This is the read-model + extractor slice of #4322 — no serializer, query namespace, creator API, or UI yet.
