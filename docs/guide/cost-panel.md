# Cost Panel

The viewer's **Cost** panel is a read-only inspector for IFC 5D cost data — `IfcCostSchedule`, `IfcCostItem`, `IfcCostValue`, and the quantities, currency, and product/task assignments attached to them. Open it from the activity bar (grouped under "Inspect").

It reads the same cost graph and decimal evaluation the SDK exposes as `bim.cost`, so anything the panel shows is reproducible from a script (see [Scripting a cost report](#scripting-a-cost-report) below) or from the CLI/MCP surfaces.

**Spreadsheet-style cost editing is out of scope.** Nothing in this panel writes to the model — every action either selects an element in 3D or reads a value.

## Layout

- **Left: schedule/item tree.** One section per loaded model. Each `IfcCostSchedule` lists the cost items assigned to it (`IfcRelAssignsToControl`); nested items (`IfcRelNests`) appear as children under their parent. Items that belong to no schedule and are not nested under another item still appear, under **Unassigned cost items** — nothing a model declares is silently dropped from the tree.
- **Right: detail.** Selecting a cost item shows its resolved amount and currency (or, if it could not be evaluated, the evaluator's own diagnostic), its quantities, its owning schedule, and its assigned products/tasks. A **Select in 3D** action selects every assigned product/task in the viewport and frames the camera on them.

## Five states, shown explicitly

The panel never collapses "there's a problem" into one generic banner. Each of these is a distinct, visible state:

| State | What it means | Where it shows |
|---|---|---|
| **Empty** | The model genuinely has no `IfcCostItem`/`IfcCostSchedule` data. | "No cost data in this model." under that model's section. |
| **Unavailable** | The panel could not read cost data for this model (no loaded IFC source bytes — e.g. a GLB-only or point-cloud load). This is a *different* state from empty: the read never happened, so "no data" would be a false claim. | "Cost data unavailable — load the IFC source to inspect costs." |
| **Unresolved** | A value or item exists but the evaluator could not resolve it to a number (a missing `IfcCostValue.AppliedValue`, an invalid number, an unsupported applied-value type, ...). | The detail pane shows "Could not be evaluated from the loaded source" plus the evaluator's diagnostic message — never a blank or a fabricated zero. |
| **Cyclic** | The evaluator detected a nesting or value-component cycle (`NESTING_CYCLE`, `VALUE_CYCLE`, `QUANTITY_CYCLE`). | A badge on the model section; the same diagnostic also surfaces in the detail pane for an affected item. |
| **Mixed-currency** | The project declares more than one `IfcMonetaryUnit`, or a value's applied currency disagrees with the project's. The panel never sums or averages across currencies, and never silently picks one. | A "Mixed currency" badge on the model section. |

## Federated sessions

With more than one model loaded, each model gets its own labeled tree section — a schedule or item is always shown as belonging to a specific model, never as an anonymous flattened row. Selecting an item's assigned products resolves through the same `FederationRegistry` every other selection path in the viewer uses, so two models that happen to reuse the same local IFC express-id never get their cost items or assigned products confused with each other.

## Scripting a cost report

The **Cost report (5D)** template in the script editor reads `bim.cost.data()` and `bim.cost.evaluateItem()` for the loaded model, prints a per-item report (resolved amount, or the diagnostic explaining why it could not be resolved), and exports a CSV. It is read-only, like the panel.

```typescript
const data = bim.cost.data()
if (!data.HasCostData) {
  console.log('no cost data in this model')
} else {
  for (const item of data.CostItems) {
    const evaluation = bim.cost.evaluateItem(item.ref)
    console.log(
      evaluation.Amount === undefined
        ? `#${item.ref.expressId} ${item.Name} — unresolved`
        : `#${item.ref.expressId} ${item.Name} — ${evaluation.Amount} ${evaluation.Currency ?? ''}`,
    )
  }
}
```

See the template itself (`Cost report (5D)` in the script editor's template list) for the full version, including CSV export and mixed-currency/cycle warnings.
