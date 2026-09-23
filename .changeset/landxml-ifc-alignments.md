---
"@ifc-lite/create": minor
---

LandXML→IFC now writes horizontal alignments as `IfcAlignment` (mapping spec v1.1, §11). Line, circular arc and clothoid segments become `IfcAlignmentHorizontalSegment`s, together with their `IfcCompositeCurve` geometry, a zero-length terminating segment and a start-station `IfcReferent`, aggregated by the project. An alignment containing anything else (an IrregularLine, a non-clothoid spiral, an unresolved point reference, a gap, or a segment whose parameters miss its authored end point) is refused whole and by name, because a gap would make every later station wrong. `IfcCreator.terrain().addAlignment` exposes the emitter, and `mapAlignments` / `alignmentMappingOf` expose the mapping as a cheap pre-flight.

Converted files now declare `FILE_SCHEMA(('IFC4X3_ADD2'))` through the new `ProjectParams.FileSchemaIdentifier`. The layouts written were always IFC4X3_ADD2's, but IfcOpenShell (and the buildingSMART validator built on it) resolves the bare `IFC4X3` token to a later development schema and rejects them (#5351). The output is now checked in CI by `ifcopenshell.validate`, and alignment geometry by IfcOpenShell's own mapping and evaluator.

Nothing published narrows or gains a required member, whichever of this and the pending release ships first. `LandXmlIfcCoverage.alignments` is optional. `LandXmlIfcSource.alignments` stays `unknown[]`: each record is shape-checked at run time (`isAlignmentRecord`), and one that is not a `LandXmlIfcAlignment` is refused by name rather than read into.
