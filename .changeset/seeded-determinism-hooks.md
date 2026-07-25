---
"@ifc-lite/encoding": minor
"@ifc-lite/create": minor
---

Opt-in determinism hooks for reproducible IFC generation. `generateUuid` and `generateIfcGuid` accept an optional `RandomSource` (a `() => number` in `[0, 1)`) so GUIDs can be drawn from a seeded generator, and `IfcCreator` gains `ProjectParams.Timestamp` (fixed creation instant for the STEP header, IfcOwnerHistory and work-schedule defaults) and `ProjectParams.GuidSource` (deterministic GlobalId source). Same options twice yields byte-identical output; defaults are unchanged (wall clock + platform CSPRNG).
