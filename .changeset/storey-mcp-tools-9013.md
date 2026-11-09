---
"@ifc-lite/mcp": minor
---

Storey tools (#9013): `storey_list`, `storey_add`, `storey_rename`, `storey_plan_edit`, `storey_edit` and `storey_delete` add, re-level and delete storeys in a loaded model through `bim.store`, the same path as the viewer's storey manager. `storey_plan_edit` dry-runs an edit and reports refusals before anything is written. Each write is one `mutation_undo` batch.
