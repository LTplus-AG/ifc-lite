---
"@ifc-lite/parser": minor
---

Add a cost (5D) read model and on-demand extractor: `extractCostOnDemand` parses `IfcCostItem`, `IfcCostValue`, `IfcCostSchedule`, `IfcRelNests` (cost item breakdown) and `IfcRelAssignsToControl` (cost-schedule-to-cost-item and cost-item-to-product assignment) into a normalized `CostExtraction`. `CostItemInfo.costQuantities` resolves `CostQuantities` in place via the shared `collectQuantitiesFromRefs` walk and never falls back to a product's `Qto_` quantity sets, so a cost estimator's deliberately adjusted quantity is never silently overwritten by the geometry-derived one. IFC2X3 (whose `IfcCostItem` carries no attributes at all) is handled explicitly rather than assumed compatible with IFC4/IFC4X3.

This is the read-model + extractor slice of #4322 — no serializer, query namespace, creator API, or UI yet.
