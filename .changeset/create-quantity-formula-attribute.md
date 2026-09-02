---
'@ifc-lite/create': patch
---

Several `IfcCreator` element/relationship writers wrote an attribute count that only matched the IFC4/IFC4X3 schema, not IFC2X3, for entities whose trailing attribute list genuinely differs between schema versions:

- `addIfcElementQuantity` omitted `IfcQuantityLength`/`Area`/`Volume`/`Weight`/`Count`'s trailing `Formula` attribute entirely (added in IFC4) instead of writing it as an unset `$` — every quantity record was one attribute short of the IFC4/IFC4X3 declaration.
- `addIfcWall`/`addIfcColumn`/`addIfcBeam` and `addIfcRelSequence` always wrote a trailing `PredefinedType`/`UserDefinedSequenceType` value, an attribute IFC2X3 does not declare at all — so a creator targeting `Schema: 'IFC2X3'` emitted one attribute too *many* for those entities, which is exactly as invalid as writing too few.

STEP part 21 requires an explicit slot for every attribute a schema version declares — no more, no fewer. The trailing attribute is now written only for schemas that declare it (IFC4/IFC4X3), driven off the creator's own `Schema` field, and omitted for IFC2X3.
