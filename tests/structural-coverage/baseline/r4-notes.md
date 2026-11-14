# R4 support and load glyphs (#9668)

Climb round R5 (glyph overlay), first slice: supports and loads. R0 to R3 are retained.

Measured on main `7b15e6b08b` (after #9764) plus this branch. Cells: **312.5/774 -> 321.5/774**. Render: **0/43 -> 9/43**. Rows remain **56/119**. No cell dropped. The scorer ran online with the complete corpus.

The new probe `render:structural-glyphs` (`probes/render.mjs`) covers the 24 connection and action rows. It reads from each file which records must draw: a connection whose `AppliedCondition` holds a true or non-zero value, and an action whose `AppliedLoad`, a configuration value or an IFC2X3 `SubsequentAppliedLoads` record holds a non-zero number. It then checks that `structuralGlyphs` (`@ifc-lite/parser/structural-glyphs`) returns a glyph at a finite position for each. Members (meshes) and reactions (results) stay on the unwritten placeholder `render:member-mesh-or-reaction`.

Why cells are not met:

- The generated coverage fixtures (`ifcopenshell/generated_structural_coverage_*.ifc`) give their curve and surface members and connections a placement but no topology representation. A curve or surface glyph has no position there, so those records are counted as not drawn. Every fail below is one of them, except where noted.
- `IFC2X3/IfcStructuralLinearActionVarying`: six Axis actions in `little_steel_frame-3D--Axis-Struc.ifc` have an all-zero first value and non-zero `SubsequentAppliedLoads`. Glyphs draw the first value only; the varying stations are not in the read model yet.
- `IFC2X3/IfcStructuralPointAction`: the Axis exports put point loads on members with no representation and an `ObjectPlacement` whose origin is the load's station along the member, written as an absolute position (`little_steel_frame-3D--Axis-Struc.ifc#6293`: (0.75, 0, 0) on a member from (1.5, 0, 5) to (3, 0, 5)). The glyph builder never takes an activity's placement origin as its position (activities often share the item's or the model's placement), so these draw nothing rather than a load in the wrong place.
- `IFC4X3/IfcStructuralPointAction`: `puntal-alfa/portal-demo.ifc` writes `IfcRelConnectsStructuralActivity` with its two ends reversed, so the read model has no item for that action.

## Every changed cell since R3

| Row | Level | R3 | R4 | Reason |
|---|---|---|---|---|
| IFC2X3/IfcStructuralCurveConnection | render | unwritten | fail | 1 problem(s) over 1 record(s): 1 of 1 record(s) with a restraining support condition draw no glyph, e.g. ifcopenshell/generated_structural_coverage_ifc2x3.ifc#44 |
| IFC2X3/IfcStructuralLinearAction | render | unwritten | partial | 1 problem(s) over 103 record(s): 1 of 103 record(s) with a non-zero load draw no glyph, e.g. ifcopenshell/generated_structural_coverage_ifc2x3.ifc#50 |
| IFC2X3/IfcStructuralLinearActionVarying | render | unwritten | partial | 1 problem(s) over 132 record(s): 7 of 132 record(s) with a non-zero load draw no glyph, e.g. ifcopenshell/generated_structural_coverage_ifc2x3.ifc#58 |
| IFC2X3/IfcStructuralPlanarAction | render | unwritten | partial | 1 problem(s) over 2 record(s): 1 of 2 record(s) with a non-zero load draw no glyph, e.g. ifcopenshell/generated_structural_coverage_ifc2x3.ifc#52 |
| IFC2X3/IfcStructuralPlanarActionVarying | render | unwritten | fail | 1 problem(s) over 1 record(s): 1 of 1 record(s) with a non-zero load draw no glyph, e.g. ifcopenshell/generated_structural_coverage_ifc2x3.ifc#64 |
| IFC2X3/IfcStructuralPointAction | render | unwritten | partial | 1 problem(s) over 31 record(s): 20 of 31 record(s) with a non-zero load draw no glyph, e.g. structural/ifc_structuralanalysisview/E1--3-Axis-Struc-Export.ifc#1599 |
| IFC2X3/IfcStructuralPointConnection | render | unwritten | pass | every record with a restraining support condition or non-zero load draws a glyph |
| IFC2X3/IfcStructuralSurfaceConnection | render | unwritten | partial | 1 problem(s) over 4 record(s): 1 of 4 record(s) with a restraining support condition draw no glyph, e.g. ifcopenshell/generated_structural_coverage_ifc2x3.ifc#46 |
| IFC4/IfcStructuralCurveAction | render | unwritten | partial | 1 problem(s) over 3 record(s): 1 of 3 record(s) with a non-zero load draw no glyph, e.g. ifcopenshell/generated_structural_coverage_ifc4.ifc#51 |
| IFC4/IfcStructuralCurveConnection | render | unwritten | partial | 1 problem(s) over 10 record(s): 1 of 10 record(s) with a restraining support condition draw no glyph, e.g. ifcopenshell/generated_structural_coverage_ifc4.ifc#41 |
| IFC4/IfcStructuralLinearAction | render | unwritten | partial | 1 problem(s) over 481 record(s): 1 of 481 record(s) with a non-zero load draw no glyph, e.g. ifcopenshell/generated_structural_coverage_ifc4.ifc#47 |
| IFC4/IfcStructuralPlanarAction | render | unwritten | partial | 1 problem(s) over 478 record(s): 1 of 478 record(s) with a non-zero load draw no glyph, e.g. ifcopenshell/generated_structural_coverage_ifc4.ifc#49 |
| IFC4/IfcStructuralPointAction | render | unwritten | pass | every record with a restraining support condition or non-zero load draws a glyph |
| IFC4/IfcStructuralPointConnection | render | unwritten | pass | every record with a restraining support condition or non-zero load draws a glyph |
| IFC4/IfcStructuralSurfaceAction | render | unwritten | fail | 1 problem(s) over 1 record(s): 1 of 1 record(s) with a non-zero load draw no glyph, e.g. ifcopenshell/generated_structural_coverage_ifc4.ifc#53 |
| IFC4/IfcStructuralSurfaceConnection | render | unwritten | fail | 1 problem(s) over 1 record(s): 1 of 1 record(s) with a restraining support condition draw no glyph, e.g. ifcopenshell/generated_structural_coverage_ifc4.ifc#43 |
| IFC4X3/IfcStructuralCurveAction | render | unwritten | fail | 1 problem(s) over 1 record(s): 1 of 1 record(s) with a non-zero load draw no glyph, e.g. ifcopenshell/generated_structural_coverage_ifc4x3.ifc#52 |
| IFC4X3/IfcStructuralCurveConnection | render | unwritten | fail | 1 problem(s) over 1 record(s): 1 of 1 record(s) with a restraining support condition draw no glyph, e.g. ifcopenshell/generated_structural_coverage_ifc4x3.ifc#42 |
| IFC4X3/IfcStructuralLinearAction | render | unwritten | fail | 1 problem(s) over 2 record(s): 2 of 2 record(s) with a non-zero load draw no glyph, e.g. ifcopenshell/generated_structural_coverage_ifc4x3.ifc#48 |
| IFC4X3/IfcStructuralPlanarAction | render | unwritten | fail | 1 problem(s) over 1 record(s): 1 of 1 record(s) with a non-zero load draw no glyph, e.g. ifcopenshell/generated_structural_coverage_ifc4x3.ifc#50 |
| IFC4X3/IfcStructuralPointAction | render | unwritten | partial | 1 problem(s) over 5 record(s): 1 of 5 record(s) with a non-zero load draw no glyph, e.g. structural/puntal-alfa/portal-demo.ifc#88 |
| IFC4X3/IfcStructuralPointConnection | render | unwritten | pass | every record with a restraining support condition or non-zero load draws a glyph |
| IFC4X3/IfcStructuralSurfaceAction | render | unwritten | fail | 1 problem(s) over 1 record(s): 1 of 1 record(s) with a non-zero load draw no glyph, e.g. ifcopenshell/generated_structural_coverage_ifc4x3.ifc#54 |
| IFC4X3/IfcStructuralSurfaceConnection | render | unwritten | fail | 1 problem(s) over 1 record(s): 1 of 1 record(s) with a restraining support condition draw no glyph, e.g. ifcopenshell/generated_structural_coverage_ifc4x3.ifc#44 |
