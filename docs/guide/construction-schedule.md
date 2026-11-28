# Construction Schedule (4D)

The **Schedule (Gantt)** panel shows a construction schedule as a Gantt chart and plays it back in the 3D view. Open it from the **Quantify** group of the panel rail. It opens in the bottom region. A deployment can switch it off with the `data.schedule` feature (see [Configuring a Deployment](./viewer-deployment-config.md)).

## Where the schedule comes from

- **From the model.** When the file contains `IfcTask` entities, the panel reads them with their `IfcTaskTime` dates, `IfcRelSequence` dependencies, assigned products (`IfcRelAssignsToProcess`) and `IfcWorkCalendar`. When the file has `IfcWorkPlan` containers, the panel lists each with its nested work schedules. IFC4 and IFC4X3 are supported. For IFC2X3 files, tasks come without dates and work calendars are not read.
- **Generated.** **Generate schedule…** builds one from the model itself (below).
- **Imported.** **Import schedule…** reads an MS Project XML (MSPDI) file or a Gantt CSV export. See [Schedule Import](./schedule-import.md). Importing replaces the current schedule and its undo history, so the panel asks first.

A model without tasks opens on an empty state that offers **Generate schedule** and **Import schedule…**.

## Generating a schedule

**Generate schedule…** opens a dialog that groups the model's products into tasks:

| Group by | Tasks |
|---|---|
| **Storey** | One per `IfcBuildingStorey`. |
| **Building** | One per `IfcBuilding`. |
| **Height** | One per height slice of the elements' actual geometry, ignoring the spatial tree. Use it when a file assigns elements to the wrong storey. The only option when the model has no spatial hierarchy. |

**Height** has its own options: the **Slice height** (default 3 m) and **Subdivide each slice** by IFC class, type name (the `IfcRelDefinesByType` type) or element `Name`, or not at all.

Every strategy takes a **Start date** (default today, 08:00), **Days per group** (default 5) and an **Order**: **Bottom-up** (default) or **Top-down**. Under **Advanced**:

| Option | Default |
|---|---|
| Lag days (between groups) | 0 |
| PredefinedType | `CONSTRUCTION` |
| Work schedule name | `Construction schedule` |
| Link tasks with FS dependencies (`IfcRelSequence` between consecutive groups) | on |
| Skip empty groups | on |
| Add an `IfcWorkPlan` container | off |

The dialog previews the task range before you generate. Generating fills the panel and turns 4D playback on. The schedule lives in the viewer until you export: the next IFC export writes the generated or edited schedule into the file.

## Editing

- Drag a task bar to move it, or drag its ends to change the start or finish. The tooltip shows the new dates and duration. Hold Shift to turn off snapping. Press Esc to cancel.
- **Add task** inserts a task after the selected one, or at the end.
- Undo and redo apply to schedule edits only (Ctrl/Cmd+Z while the panel is active, or the toolbar buttons).
- Selecting tasks highlights their products in 3D.

Edits stay in the viewer until you export the model to IFC, which writes them into the file.

## Timeline and playback

The toolbar sets the time scale (hour, day, week, month, year), jumps to the start or finish, plays or pauses, loops, and sets the speed in days, weeks or months per second. The playback position can also be dragged. A model without real dates gets a synthetic range, marked **No dates**.

When the file assigns an `IfcWorkCalendar`, the timeline offers **Respect work calendar**: non-working days are shaded and playback skips them.

### 4D animation settings

The animation settings popover controls how playback changes the 3D view:

- **Style.** **Minimal** changes visibility only. **Phased** paints colour overlays by task type (the `IfcTaskTypeEnum` value), with an editable palette.
- **Timing.** **Hide upcoming products**, **Hide unscheduled products** (products in no task), and **Animate demolition** (remove products when demolition tasks finish).
- **Colour overlays** (Phased only). **Colour by task type**, a **Preparation ghost** that dims products inside the **Look-ahead window**, **Tint completed products**, and **Colour intensity** (0 % equals Minimal, 100 % is solid paint).

**Reset defaults** restores the default settings.

## Related

- [Charts](./charts.md) can chart schedule tasks and follow the 4D playback.
- Scripts read the schedule through `bim.schedule.data()`, `tasks()`, `workSchedules()` and `sequences()` (see [Scripting SDK](./scripting-sdk.md)).
