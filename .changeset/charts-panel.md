---
"@ifc-lite/viewer": minor
---

New **Charts** panel (#3944): a dashboard of charts bound to the loaded models, bidirectional with the 3D view. Click a bar or slice to select its elements (ghosting the rest by default, or isolate / highlight), pick in 3D to light up the matching bucket, and let one chart's selection slice the others. The `elements` source charts IFC type, storey, model and name across the federation, scoped to all models, the visible set or the basket; "Colour in 3D" paints the model by the first chart's buckets. Dashboards persist like saved lists; the first open seeds a *Model overview*. Bottom strip next to Lists and Schedule, in the ribbon's Analyze → Data group, the classic toolbar's Workspace menu and the command palette.
