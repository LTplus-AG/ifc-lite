# R3 combined authoring measurement after #9737 (#9668)

This is a measurement revision after merging main, not another domain climb round. R1 and R2 are retained.

Measured main: `edb8173bdf50262ae99376294dc6034cc486077a` (includes #9737 and #9763). Cells: **288.5/774 -> 312.5/774**. Create: **49.5/110 -> 73.5/110**. Rows remain **56/119**. The branch still contributes the same 24 create passes recorded in R2. Runtime validation and default-name fixes add no score cells.

Compared with R2, the 15 additional create passes below come from #9737 on main. No cell drops and no other level changes. The scorer ran online with the complete corpus; no probes or perf ceilings were weakened.

## Every changed cell since R2

| Row | Level | R2 | R3 | Reason |
|---|---|---|---|---|
| IFC2X3/IfcBoundaryEdgeCondition | create | fail | pass | Already on measured main via #9737. |
| IFC2X3/IfcBoundaryFaceCondition | create | fail | pass | Already on measured main via #9737. |
| IFC2X3/IfcStructuralCurveConnection | create | fail | pass | Already on measured main via #9737. |
| IFC2X3/IfcStructuralSurfaceConnection | create | fail | pass | Already on measured main via #9737. |
| IFC2X3/IfcStructuralSurfaceMember | create | fail | pass | Already on measured main via #9737. |
| IFC4/IfcBoundaryEdgeCondition | create | fail | pass | Already on measured main via #9737. |
| IFC4/IfcBoundaryFaceCondition | create | fail | pass | Already on measured main via #9737. |
| IFC4/IfcStructuralCurveConnection | create | fail | pass | Already on measured main via #9737. |
| IFC4/IfcStructuralSurfaceConnection | create | fail | pass | Already on measured main via #9737. |
| IFC4/IfcStructuralSurfaceMember | create | fail | pass | Already on measured main via #9737. |
| IFC4X3/IfcBoundaryEdgeCondition | create | fail | pass | Already on measured main via #9737. |
| IFC4X3/IfcBoundaryFaceCondition | create | fail | pass | Already on measured main via #9737. |
| IFC4X3/IfcStructuralCurveConnection | create | fail | pass | Already on measured main via #9737. |
| IFC4X3/IfcStructuralSurfaceConnection | create | fail | pass | Already on measured main via #9737. |
| IFC4X3/IfcStructuralSurfaceMember | create | fail | pass | Already on measured main via #9737. |

## Review decisions

- Fixed runtime enum/boolean validation and missing AppliedLoad diagnostics in the new activity/result builders. Regression tests failed before the fix, and reject invalid input without partial writes.
- Default activity names now follow the existing Point Action style. Temperature JSDoc explains the IFC4 parameter names and IFC2X3 DeltaT_Constant / DeltaT_Y / DeltaT_Z slots.
- Restored JSDoc on all nine existing SDK methods, documented all new methods, and unified all 18 structural registrations, including #9737's three, behind one missing-backend error path. TypeScript documentation lookup against the emitted declarations verifies all 18 inherited method descriptions.
- Deferred consolidation with structural-action.ts: that otherwise untouched module uses flat force parameters, presence-only validation and schema-specific boolean serialization. Sharing its private helper and emit path would change existing builders, rather than being a small edit within already-touched files. The old point/linear builders' GlobalOrLocal and DestabilizingLoad runtime-validation gaps remain a follow-up; they do not share the new helper.

All previously listed varying-load, warping/distortion, read, conversion, edit/remove and UI gaps remain outside this slice. See r2-notes.md for the original row list.
