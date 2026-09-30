---
"@ifc-lite/create": minor
"@ifc-lite/viewer": patch
---

Copying an assembly (an IfcStair with its flights, a curtain wall with its plates and members, anything with IfcRelAggregates parts) now copies the parts too, at every depth, with the aggregation re-created and fresh GlobalIds. A part on its own is refused: it is copied with its assembly. `CopyProductResult` gains `partIds`. A copy whose placement chain does not reach its storey's placement is now refused instead of guessed, so the committed copy always lands where the preview shows it (#6232 C3).
