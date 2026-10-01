---
"@ifc-lite/export": minor
"@ifc-lite/parser": minor
---

Add opt-in STEP map-unit normalization to metres while preserving physical map coordinates, project geometry and project units. Export the shared IFC SI-prefix factors for the normalization consumer, so readers and writers use the same factors. Unsupported coordinate operations, ambiguous project units and retained WKT unit definitions are preserved with explicit export warnings.
