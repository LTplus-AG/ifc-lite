---
"@ifc-lite/create": minor
"@ifc-lite/sdk": minor
---

Add schema-aware structural scalar edits and ownership-aware structural removal. Required direct dependents refuse removal; relationships detach or retain surviving members, and shared resources stay live. Generic entity editing and removal keep their existing behavior.

IFC2X3 curve members stop emitting an unreferenced axis direction. `StructuralCurveMemberBuildResult.axisDirectionId` is now optional because IFC2X3 has no Axis attribute.
