---
"@ifc-lite/parser": minor
"@ifc-lite/cli": minor
---

`ifc-lite validate` reports where the physical model and the structural analysis model in one file disagree (#9668), as warnings naming each entity by express id and `GlobalId`: a load-bearing beam, column, member, slab, wall, footing or pile with no structural item assigned (`structural-unlinked-element`; validate lists the first 50 and counts the rest in one summary), a structural member or connection with no physical element (`structural-unlinked-item`), and a curve member on a slab or wall or a surface member on a beam, column or member (`structural-class-mismatch`). `ValidationIssue` gains optional `globalId` and `targetGlobalId`. `@ifc-lite/parser` exports the checks as `structuralConsistencyIssues(store, options)`, which returns every finding uncapped. An element whose `LoadBearing` is missing or not a boolean counts as load bearing unless `unsetLoadBearing: false`.
