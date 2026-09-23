---
'@ifc-lite/parser': minor
---

Fix `extractAllMaterialsOnDemand` to resolve materials via the relationship graph on server-parsed models (issue #5227). Reorder the source-empty check so it runs AFTER consulting the graph, matching the classification resolver's fix for #3948. When a server-parsed store has no source bytes but the relationship graph resolves material associations, return unresolved markers instead of an empty list, distinguishing "materially-associated but unresolved" from "genuinely unmaterialed".
