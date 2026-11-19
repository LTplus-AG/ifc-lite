---
"@ifc-lite/export": patch
"@ifc-lite/viewer": patch
---

Visible-only IFCX export leaves out a hidden entity even when an isolation includes it, as STEP export does. Viewer exports now write the right model's data: KMZ leaves out an overlapping-id model's instanced geometry, a legacy model's pending edits reach its LandXML terrain export, and the agent export operations refuse a composed IFCX layer, export a legacy single model, and discard a visible-only STEP export when the view changes.
