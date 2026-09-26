---
"@ifc-lite/export": patch
---

`StepExporter` now cleans up references in created (overlay) entities the way it already did for source records: a created `IfcStyledItem`, layer assignment, texture map or non-relationship aggregate (e.g. `IfcShapeRepresentation.Items`) that names a deleted or otherwise omitted entity is narrowed or withheld with a warning, instead of being written with a dangling `#id` (#5941 review).
