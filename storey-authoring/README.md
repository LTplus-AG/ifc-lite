# Storey authoring in the Model workspace (#9013)

The production viewer build of the storey stack (`33600c85ad`) running in
Windows Chrome on a real GPU (WebGPU, `ifc-gpu-check`), driven through the
real UI: the storey chip and picker, the storey manager, the Model tools and
the Export dialog. Mesh positions are read in world space (`origin +
positions`). `gpu-walkthrough.json` holds every measured step for the light
and dark runs and the third-party run, with IfcOpenShell results.

| | Light | Dark |
| --- | --- | --- |
| Storey picker before (`main`) | `before-picker-light.png` | `before-picker-dark.png` |
| Storey picker after: Add storey above, Manage storeys | `after-picker-light.png` | `after-picker-dark.png` |
| Level 1 floor-to-floor 3.00 → 3.50, live preview with impact | `step4-preview-light.png` | `step4-preview-dark.png` |

`storey-walkthrough.mp4` (80 s) records the whole light run.

## Steps

1. **Blank model, Level 1.** Four walls, a door and a window hosted in them,
   and a slab, drawn with the Model tools.
2. **Add Level 2 at +3.00.** "Add storey above" in the picker creates Level 2,
   aggregated under the building, and makes it the active storey. Two walls
   are drawn on it.
3. **Stair.** A stair on Level 1 that lands on Level 2, plus a fixed-height wall.
4. **Floor-to-floor 3.50.** The preview reads "Moves 1 storey · moves 2
   elements · resizes 4 walls · refits 1 stair". After Enter:
   - Level 2 rises from 3.00 to 3.50 in world space, with both of its walls.
   - The four attached Level 1 walls are 3.50 tall.
   - The fixed-height wall stays at 3.00.
   - The stair's top reaches 3.50.
   - The door and window keep their world boxes.
5. **Elevation edit.** Level 2 goes to +3.80. Its walls move to 3.80, the
   attached walls are 3.80 tall, the stair refits to 3.80, and the slab stays
   where it is.
6. **Invalid edit.** A floor-to-floor of 0.20 m is refused before anything is
   applied: "Not applied: The stair #368 from Level 1 to Level 2 would have to
   climb 0.20 m: no flight fits; move or delete the stair first". The model is
   unchanged (`step6-refused-light.png`).
7. **Undo and redo.** Undo goes back to a blank model and redo returns to the
   step-5 state, mesh for mesh. Each storey edit is one undo step.
8. **Export.** The IFC4 and IFC4X3 exports from the Export dialog reload in a
   fresh page. All 13 world boxes match the live model in both
   (`step8-reloaded-ifc4x3-light.png`).
9. **Validation.** IfcOpenShell reports 0 schema errors on all four exports
   (light and dark, IFC4 and IFC4X3). An independent parse finds:
   - Level 2 at Elevation 3.8, with placement Z 3.8.
   - Both storeys aggregated under the building.
   - The Level 1 walls with a 3.8 m body and an `IfcLite_StoreyAttachment.TopConstraint`
     naming Level 2's GlobalId.

   The first walkthrough on this stack found two orphaned
   `IfcProductDefinitionShape` records left behind by stair refits. The stair
   editor now removes the shape it replaces.
10. **Third-party file (ArchiCAD AC20-FZK-Haus).** Erdgeschoss floor-to-floor
    goes from 2.70 to 3.00:
    - The preview names the spiral stair as moved but not refit.
    - 60 meshes rise exactly 0.30 m and 59 stay where they are.
    - The hierarchy badge reads Dachgeschoss +3.00 m.
    - Undo and redo restore each state.
    - IFC4 and IFC4X3 exports reload with all 119 world boxes matching.
    - IfcOpenShell finds the original file's own 5 `IfcRelSpaceBoundary`
      errors in IFC4.
    - In IFC4X3 it finds the same 125 `IfcQuantityCount` errors that a plain
      `ifc-lite convert` of the unedited file produces. The storey edit adds none.

    This run also found a bug: a source storey's hierarchy badge kept its file
    elevation after an edit. It is fixed in this PR.
