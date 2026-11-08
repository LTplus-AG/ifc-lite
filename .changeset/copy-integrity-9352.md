---
"@ifc-lite/create": minor
"@ifc-lite/sdk": minor
"@ifc-lite/mcp": patch
"@ifc-lite/viewer": minor
---

Copies never drop or silently mis-attach an element (#9352). `bim.store.copyElements`, `arrayElements` and `copyToStoreys` return one ref per selected element per transform: a door selected with its wall used to be copied with the wall but left out of the result, so a copied floor came back one element short. New `copiesOfSelection` maps a selection to its copies. A copy whose top cannot follow its new storey is listed in its ref's `unattachedTops` (also in `copyToStoreysInStore`'s per-storey result, the MCP copy tools and a viewer toast); a copy whose placement cannot be read is now cleared and listed instead of staying attached at the wrong height. `copyProductInStore` writes the copy and its attachment re-bind atomically. `auto` attaches a level beam whose top face meets the storey above. The viewer's `bim.store.addCurtainWall` and `addColumnOnGrid` apply `TopConstraint` as headless does.
