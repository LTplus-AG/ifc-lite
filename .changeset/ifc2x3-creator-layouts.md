---
"@ifc-lite/create": minor
---

`IfcCreator` with `Schema: 'IFC2X3'` now writes schema-valid IFC2X3:

- **Elements:** doors, windows, openings, plates, members and curtain walls use IFC2X3 attribute layouts. Proxies write `$` for `CompositionType` instead of `.NOTDEFINED.`, and piles write `.NOTDEFINED.` instead of the IFC4-only `.DRIVEN.`.
- **Generic writers:** `addElement` and `addAxisElement` write every attribute after `Tag` from the target schema:
  - The classification slot (`PredefinedType`, or IFC2X3 `CompositionType` / `ShapeType`) gets the caller's value, checked against its enum. `NOTDEFINED` becomes `$` where the enum lacks it.
  - Other optional slots, such as IfcDoor `OverallHeight`, are `$`.
  - A `PredefinedType` on an entity without a classification slot, or a value outside its enum, throws.
- **Profiles and materials:** I/L/T/U/C profiles and materials (`IfcMaterial`, `IfcMaterialLayer`, `IfcMaterialLayerSet`) use IFC2X3 layouts.
- **Styles and placements:** `IfcStyledItem` references an `IfcPresentationStyleAssignment`, and site, building and storeys nest their placements as IFC2X3 requires.
- **Scheduling:** tasks write the IFC2X3 `IfcTask` layout, and sequences write a zero `TimeLag`. Task times, lag durations, work schedules and work plans have no IFC2X3 form here, so they now throw a clear error instead of writing invalid records.

**New errors (IFC2X3 only, plus the generic-writer check):** `addIfcTask` with task times, `addIfcRelSequence` with `TimeLag`, `addIfcWorkSchedule`, `addIfcWorkPlan`, and `addElement` / `addAxisElement` with a `PredefinedType` the target entity cannot hold. Each previously wrote invalid IFC.

IFC4 and IFC4X3 fixes:

- `IfcUShapeProfileDef` gains its missing `FlangeSlope` slot.
- A generic `IfcFlowSegment` no longer gets a `PredefinedType` it doesn't have.
