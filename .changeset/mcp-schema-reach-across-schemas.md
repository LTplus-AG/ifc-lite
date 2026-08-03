---
'@ifc-lite/mcp': minor
---

**model_audit / schema_describe**: both now read the IFC schema across every bundled version instead of the IFC4_ADD2_TC1 codegen pin alone (issue [#2003](https://github.com/LTplus-AG/ifc-lite/issues/2003)).

`model_audit`'s GlobalId-uniqueness check skips any type whose inheritance chain does not reach `IfcRoot`, and the pinned lookup answers an **empty** chain for any class it has no row for: 39 IFC2X3 classes (`IfcScheduleTimeControl`, `IfcSpaceProgram`, `IfcServiceLife`, `IfcMove`, …), 80 IFC4X3 ones (`IfcCourse`, `IfcBorehole`, …) and 4 post-ADD2 IFC4 ones. The audit skipped every one of them and still scored the file on identity, so an agent was told a file was clean on a rule that had not run. It now checks them, and `duplicate-globalid` can fire on files where it previously stayed silent.

`schema_describe` rejected those same classes with `INVALID_INPUT: Unknown IFC entity type` — for a class an agent may have just found with `query_entities` on the file it is holding. It now answers from the bundled schema union when the pin has no row, and the payload gains a `schemaSource` field: `IFC4_ADD2_TC1` when the pinned registry answered (attributes carry their EXPRESS type as before) or `bundled-schema-union` when it did not (attribute *names* in positional order, no types — the union does not carry them, and inventing them would be worse than saying so).

For every class the pin does carry, `schema_describe`'s answer is unchanged, `inheritanceChain` included. That is deliberate rather than incidental: the two lookups disagree on chain *content* for 62 pinned classes because the union lets IFC4X3 win a name collision (`IfcBeam`'s supertype is `IfcBuildingElement` in IFC4 and `IfcBuiltElement` in IFC4X3, and IFC4X3 inserts `IfcFacility` above `IfcBuilding`), so the pin stays primary and the union only fills the gap. They also return their chains in opposite order — the pinned one root→leaf, the union one leaf→root, differing at `chain[0]` on 717 of the 776 — so the chain is normalised by finding the leaf by name, never by index.
