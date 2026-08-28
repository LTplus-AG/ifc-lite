---
'@ifc-lite/viewer': patch
---

Fix the SDK/MCP `isolate()` call (scripts and the `viewer_isolate` tool) isolating a geometry-less `IfcElementAssembly` by its own id instead of its `IfcRelAggregates` parts, which showed an empty viewport (#3338).

Assembly expansion has one shared implementation, `expandToGeometryBearingIds`, reached through `cameraCallbacks.resolveHighlightIds`. LensPanel, PropertiesPanel and both SearchModal isolate paths already route through it; `apps/viewer/src/sdk/adapters/visibility-adapter.ts`'s `isolate()` — reached by scripts and the MCP `viewer_isolate` tool — expanded spatial-structure refs (storey, building) but never routed its result through the same resolver, so isolating an assembly by ref left an id with no mesh in the isolation set. It now resolves through `cameraCallbacks.resolveHighlightIds` the same way the other channels do, falling back to the unresolved ids when no renderer has registered one yet.
