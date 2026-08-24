---
"@ifc-lite/ifcx": major
---

Fix `IfcxWriter` discarding every entity's IFC GlobalId.

A node's `path` IS its identity in IFCX: `entity-extractor.ts` hands the path straight back as the GlobalId, `packages/export`'s IFC5 exporter keys its nodes by GlobalId for exactly that reason, and the buildingSMART v5a schemas committed under `packages/export/src/__fixtures__/schemas/` define no attribute that could carry a GlobalId instead — there is no other slot for it.

`IfcxWriter` read each entity's GlobalId into a local variable, never used it, and synthesized `ifc:<Type>.<expressId>` as the path instead. So a STEP → IFCX export replaced every real IFC GlobalId with an invented one, and expressId is not stable across files, so nothing downstream could re-match or federate the node. The GlobalId is now the path when the entity has one; the synthetic form remains the fallback for an entity without one, and an explicit `idToPath` entry still wins over both so a round-trip preserves the paths the source file authored.

Invisible until now because the writer's test helper accepted a `globalId` field that no fixture ever set: every path assertion in the suite only exercised the fallback.
