---
'@ifc-lite/viewer': patch
'@ifc-lite/viewer-embed': patch
'@ifc-lite/mcp': patch
---

Fix `hide()`, `show()`, `colorize()`, `colorizeAll()` and `resetColors()` doing nothing when given a geometry-less `IfcElementAssembly`, over both the SDK and the embed's postMessage bridge (#3338).

Isolation already expanded such an id to its `IfcRelAggregates` parts. Its sibling channels did not, and they fail the same way for the same reason: the renderer matches `hiddenEntities` and the mesh colour map against ids it saw on a MESH, and an assembly carries no mesh of its own. So `hide([assemblyRef])` left every part visible, `colorize([assemblyRef], red)` repainted nothing, and both reported success. The embed bridge's `HIDE`, `SHOW` and `SET_COLORS` commands had the identical gap.

All of them now route through the shared expansion policy, which moved from `lib/isolation/resolveIsolationIds.ts` to `lib/presentation/resolvePresentationIds.ts`. The old name was part of the problem: a `hide` handler author reading "isolation ids" concludes the module is not theirs and hand-rolls the id list, which is exactly the "one call site every channel must remember to use" failure #3338 is about. The colour channel gets `resolvePresentationColorMap`, which keeps each id paired with its own colour, calls the resolver once per distinct colour rather than once per id, and lets an explicitly named part outrank the colour it would inherit as some assembly's part.

On the MCP side the same expansion moved from the five viewer tools that each remembered to call it into the one `resolveTargetRefs` they all share, so a sixth tool gets it by construction. No behaviour change there.
