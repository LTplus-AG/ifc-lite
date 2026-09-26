# Bulk edit target sources (#5890)

The browser test loads two authored buildingSMART IFC samples from `apps/viewer/public/samples/`, selects one `IfcWall` in the first model and two in the second, and opens the Author ribbon's Bulk Property Editor. The screenshot shows the Selection source and exact three-entity count before applying `Pset_BulkTargetWitness.Code = ONLY_THREE`.

The test reads each model's mutation view after Apply: all three selected walls have the new value, while an unselected wall in the second model does not. It then sends one Ctrl+Z and checks that all three values are absent. Run:

```sh
PLAYWRIGHT_PORT=4410 pnpm exec playwright test tests/e2e/bulk-target-sources.e2e.spec.ts --project=viewer-e2e-ci --workers=1
```

Result: 1 passed on Chromium, 2026-09-26, against the rebased viewer build (61/61 root build tasks). The mounted editor tests also cover a one-model text search result and a one-model filter result.
