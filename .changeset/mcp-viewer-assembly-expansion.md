---
'@ifc-lite/mcp': patch
'@ifc-lite/data': minor
---

Fix `viewer_isolate` (and the same gap in `viewer_hide`/`viewer_show`/`viewer_colorize`) resolving a `global_id`/`global_ids`/`express_id`/`express_ids` selector by direct lookup only, with no `IfcRelAggregates` expansion. An `IfcElementAssembly` (or any other decomposition container — a wall's `IfcBuildingElementPart`s, a stair used as a container, …) carries no mesh of its own; its parts do. `packages/viewer`'s renderer keys every color/visibility override off actually-rendered mesh ids, so an unexpanded container id in `viewer_isolate` matched nothing, and every rendered entity got dimmed to near-invisible — isolating a geometry-less assembly appeared to blank the whole model. `viewer_hide`/`viewer_show`/`viewer_colorize` had the quieter version of the same bug: a silent no-op on the container id.

`packages/mcp`'s viewer tools now expand any ref with `IfcRelAggregates` children into itself plus every decomposition descendant before it reaches the viewer. A plain element id with no decomposition children passes through unchanged.

`@ifc-lite/data` gains `getAggregatedChildren` and `collectAggregatedDescendants`, the `IfcRelAggregates` traversal this expansion is built on — moved out of `apps/viewer`'s `utils/aggregation.ts` (which re-exports them under their existing names) so both that app and `packages/mcp` share one traversal instead of each carrying its own copy.
