---
"@ifc-lite/viewer": minor
---

Add a read-only Cost panel for inspecting IFC 5D cost schedules, nested
cost items, resolved values, quantities, currency, diagnostics, and
assigned products/tasks. Selecting a cost item selects its assigned
products through the viewer's `FederationRegistry`, so a federated session
resolves the right model even when two models share the same local
express-id.

Empty, unresolved, cyclic, mixed-currency, and federated states are each
shown explicitly rather than collapsed into one generic banner. Adds a
"Cost report (5D)" scripting template and user documentation
(`docs/guide/cost-panel.md`). No spreadsheet-style cost editing —
read-only, as scoped.
