# Viewer panel groups (#5873)

These screenshots come from the built viewer in headless Chrome at 1600 × 1000. The browser loaded the authored `apps/viewer/public/samples/building-architecture.ifc` through the normal viewer URL. Its IFC header identifies SketchUp 2024 and IFC Manager for SketchUp 5.3.3; the visible hierarchy and 12-element status confirm the loaded model.

- [Browse panels](authored-ifc-panel-browser.png) shows the Analyze ribbon's registry-driven task groups alongside the matching rail headings.
- [Point Clouds empty state](authored-ifc-point-cloud-empty.png) shows a panel opened from the ribbon before a scan is loaded. It remains available in the rail and tells the user what to load.

Reproduce with `PLAYWRIGHT_PORT=5397 pnpm exec playwright test tests/e2e/panel-groups-5873.e2e.spec.ts --project=viewer-e2e-ci`. The Chrome capture's WebGPU canvas is blank; the screenshots document panel navigation and empty-state behavior, while the test asserts the model load event and group controls.
