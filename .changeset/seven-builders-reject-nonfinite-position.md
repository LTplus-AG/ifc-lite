---
"@ifc-lite/create": minor
---

`addColumnToStore`, `addDoorToStore`, `addWindowToStore`, `addSlabToStore`, `addRoofToStore`, `addPlateToStore`, `addSpaceToStore` (and the equivalent `IfcCreator.addIfc*` legacy methods) now reject a non-finite `Position` (`NaN`/`Infinity`), matching the guard `addWallToStore`/`addBeamToStore`/`addMemberToStore` already apply to `Start`/`End`. Previously a non-finite `Position` reached the STEP serializer, which writes a non-finite number as `$` — valid syntax for an omitted optional attribute, but not for a member of `IfcCartesianPoint.Coordinates` (`LIST [1:3] OF IfcLengthMeasure`, mandatory), producing an invalid IFC file with no error. This is a new thrown error on a path that previously accepted the value silently, so callers passing a computed (possibly non-finite) `Position` — e.g. an offset derived from a zero-length reference — will now see a thrown `Error` instead of a corrupt export.
