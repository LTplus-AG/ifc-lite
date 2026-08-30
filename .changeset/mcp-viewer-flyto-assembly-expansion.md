---
'@ifc-lite/mcp': patch
---

Fix `viewer_fly_to` resolving a `global_id`/`global_ids`/`express_id`/`express_ids` selector by direct lookup only, with no `IfcRelAggregates` expansion — the same gap already fixed in `viewer_isolate`/`viewer_hide`/`viewer_show`/`viewer_colorize`. An `IfcElementAssembly` (or any other decomposition container) carries no mesh of its own; its parts do. `packages/viewer`'s renderer computes the fly-to camera target's bounding box only from actually-rendered mesh ids, so an unexpanded container id matched nothing and the camera silently did not move.

`viewer_fly_to` now expands any ref with `IfcRelAggregates` children into itself plus every decomposition descendant before it reaches the viewer, using the same `expandAssemblyRefs` helper as the other viewer tools. A plain element id with no decomposition children passes through unchanged.
