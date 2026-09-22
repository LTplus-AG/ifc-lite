---
'@ifc-lite/create': minor
'@ifc-lite/sdk': minor
'@ifc-lite/cli': minor
'@ifc-lite/mcp': patch
---

Structural analysis authoring (#5167).

`@ifc-lite/create` gains in-store builders for `IfcStructuralAnalysisModel`, `IfcStructuralCurveMember`, `IfcStructuralPointConnection`, `IfcStructuralLoadGroup`/`IfcStructuralLoadCase`, `IfcStructuralPointAction` and `IfcStructuralLinearAction`, plus `IfcRelConnectsStructuralMember`, `IfcRelConnectsStructuralActivity` and `IfcRelAssignsToGroup`. Each entity owns its representation outright — nothing is shared between entities — and every build result exposes the express ids it owns.

`bim.store.addStructural*` reaches them through a shared `createStructuralStoreBackend` factory, wired into the CLI backend and the viewer store adapter from the same per-call resolution the cost surface uses, so an entity authored through either is visible to the next call on the other. MCP v0.1 authors through `entity_create` and refuses these explicitly.
