---
"@ifc-lite/renderer": patch
---

LOD1 no longer depends on the order a model's pieces arrive in. The cluster grid is anchored in world space and each cell elects a canonical representative vertex (smallest position, then normal) instead of the first one referenced, so two loads of one file draw the same LOD1 geometry. `simplifyIndicesByClustering` takes an optional layout object as its fifth argument (`idLaneOffset`, `normalOffset`, `frameOrigin`); a bare number is still read as the entity-lane offset.
