---
"@ifc-lite/parser": patch
---

Loading a saved IFC file with `IfcProject.UnitsInContext` set to `$` now uses SI defaults in both source and view-backed reads. Explicitly clearing the assignment during editing keeps the unit context unavailable until the saved file is reopened or units are reassigned.
