---
"@ifc-lite/create": minor
---

`IfcCreator` with `Schema: 'IFC2X3'` now writes schema-valid IFC2X3:

- **Elements:** doors, windows, openings, plates, members and curtain walls use IFC2X3 attribute layouts. Proxies write `$` for `CompositionType` instead of `.NOTDEFINED.`, and piles write `.NOTDEFINED.` instead of the IFC4-only `.DRIVEN.`.
- **Generic writers:** `addElement` and `addAxisElement` follow the target schema. The `PredefinedType` slot is written only where the entity has one. Passing a `PredefinedType` to an entity without one throws. On an IFC2X3 proxy, it maps onto `CompositionType`: `NOTDEFINED` writes `$`, and a value outside COMPLEX/ELEMENT/PARTIAL throws.
- **Profiles and materials:** I/L/T/U/C profiles and materials (`IfcMaterial`, `IfcMaterialLayer`, `IfcMaterialLayerSet`) use IFC2X3 layouts.
- **Styles and placements:** `IfcStyledItem` references an `IfcPresentationStyleAssignment`, and site, building and storeys nest their placements as IFC2X3 requires.
- **Scheduling:** tasks write the IFC2X3 `IfcTask` layout, and sequences write a zero `TimeLag`. Task times, lag durations, work schedules and work plans have no IFC2X3 form here, so they now throw a clear error instead of writing invalid records.

**New errors (IFC2X3 only, plus the generic-writer check):** `addIfcTask` with task times, `addIfcRelSequence` with `TimeLag`, `addIfcWorkSchedule`, `addIfcWorkPlan`, and `addElement` / `addAxisElement` with a `PredefinedType` the target entity cannot hold. Each previously wrote invalid IFC.

IFC4 and IFC4X3 fixes:

- `IfcUShapeProfileDef` gains its missing `FlangeSlope` slot.
- A generic `IfcFlowSegment` no longer gets a `PredefinedType` it doesn't have.
