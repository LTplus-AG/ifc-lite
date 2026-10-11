---
'@ifc-lite/viewer': minor
---

Add IDS Studio, a panel for authoring IDS files without touching XML. It has an outline of specifications and facets with keyboard navigation, and an inspector for document info, specifications, cardinality and all six facet types. Its pickers are grounded in the IFC schema: property sets are filtered to the applicable entities and abstract classes are flagged. A value editor covers every restriction kind, with enumeration chips, bulk paste, a sample tester and unit-aware numbers. Diagnostics come with quick-fix previews, and a read-only XML preview highlights the selection. You can open and save `.ids` and `.idsz` files, or drop one on the panel to open it. Every edit goes through the `@ifc-lite/ids-authoring` grounding gate as one undoable step.
