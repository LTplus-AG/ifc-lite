---
"@ifc-lite/renderer": minor
"@ifc-lite/viewer": patch
---

Splitting a wall now removes the source wall's mesh from the store and the scene. Walls and other elements added in the viewer carry per-vertex entity ids that name only themselves, and removal used to treat them as colour-merged meshes and keep them, so the triangle count still drifted and the source reappeared on the next scene rebuild. Removal now keeps only meshes that host other entities (`hostsOtherEntities`).
