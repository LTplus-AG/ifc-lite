# Ribbon entity actions (#5870)

The [1280 × 900 Chrome capture](ribbon-entity-actions-authored-ifc.png) shows the Elements ribbon's registered **Entity actions** control opening the existing context menu for a selected `IfcWall` in the authored SketchUp `building-architecture.ifc` sample. The hierarchy and Properties panel identify the selected wall, and the viewer reports 12 loaded geometry elements.

`tests/e2e/ribbon-entity-actions.e2e.spec.ts` loads that IFC in real Chrome with WebGPU, selects a wall by its federated global ID, clicks the ribbon control, checks that the menu owns the same ID and offers Select all IfcWall and Select same storey, then selects the storey and verifies the wall remains in the resulting selection. Local `viewer-e2e-ci` run: 1/1 passed.
