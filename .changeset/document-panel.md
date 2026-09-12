---
"@ifc-lite/viewer": minor
---

New **Document** panel (#4594): a free-form page over the model, printed to PDF. Blocks are text whose `{fields}` read the loaded IFC (`{IfcProject.Name}`, `{IfcBuildingStorey["Level 1"].Elevation}`, `{Element[<GlobalId>].Pset_WallCommon.FireRating}`, `{Count[IfcWall]}`, `{Model.Name}`, `{Today}` — *Insert field* offers the project, storeys and the selected element's attributes and properties), a logo, a chart copied from a dashboard (optionally with a 3D snapshot), and a BCF topic by GUID with its viewpoint snapshot. The preview resolves live; a binding the model cannot answer is marked and printed as `[path: reason]`, never blanked. A document is a template — it stores bindings, not values — saved in the browser and shared as `.ifclite-document.json`, so the same page re-opened on the next model revision reads that revision. Presets: blank page, cover sheet. Bottom strip next to Charts, in Analyze → Data, the Workspace menu and the command palette.
