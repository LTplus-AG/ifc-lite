---
"@ifc-lite/parser": minor
"@ifc-lite/export": minor
"@ifc-lite/create": minor
"@ifc-lite/sdk": minor
"@ifc-lite/cli": minor
"@ifc-lite/mcp": patch
---

Loaded-model cost authoring (#4857 PR A — part of #4857; export coexistence lands in PR B).

`CostMutationOverlay` gains `created()`: every entity `bim.store.addCost*` authors is now visible to `bim.cost.data()` before the model is ever exported, reading through `@ifc-lite/export`'s `effectiveCreatedRecord` (extracted from `effectiveAppearanceRecord` as the one writer for an overlay-created entity's record text) so an authored `IfcCostItem` reads exactly as the file that will be exported would state it.

`@ifc-lite/create` adds pure `StoreEditor` builders for `IfcCostSchedule` / `IfcCostItem` / `IfcCostValue` / `IfcPhysicalSimpleQuantity`, nesting (`IfcRelNests`, with reparent-on-renest), assignment (`IfcRelAssignsToControl`, cost-item-to-schedule and product/task-to-cost-item), `CostValues` replacement, and safe deletion (refuses to delete a still-referenced `IfcCostValue` unless `{ detach: true }`, cascades to values referenced only by a removed item). The shared validation (`assertCostSchema`, `typedValue`, allow-lists) moves into a schema-free `cost-authoring-rules.ts` both this and `IfcCreator`'s from-scratch cost emitters call, so the same value is illegal from either entry point.

`bim.store` gains `addCostSchedule` / `addCostItem` / `addCostValue` / `addCostQuantity` / `nestCostItems` / `assignCostItemsToSchedule` / `assignToCostItem` / `setCostItemValues` / `removeCostEntity`, built on the new `createCostStoreBackend` (`@ifc-lite/sdk`), wired into the CLI headless backend. The MCP headless backend stubs the same methods (its v0.1 convention for every other `bim.store.add*` builder — agent flows use `entity_create`) but now threads its `MutablePropertyView` into `createCostBackend`, so `bim.cost` reads observe whatever `entity_create` authors there too.

Left for follow-ups, stated in the PR: the viewer's cost panel stays read-only by design (`docs/guide/cost-panel.md`); the viewer SDK adapter and sandbox `bim.store` bridge are not yet wired to the new methods; undo/redo for `bim.store.addCost*` is not yet routed through the viewer's `CREATE_ENTITY` history.
