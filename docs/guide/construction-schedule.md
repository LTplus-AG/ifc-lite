# Construction Schedule (4D)

The **Schedule (Gantt)** panel shows a construction schedule as a Gantt chart and plays it back in the 3D view. Open it from the **Quantify** group of the panel rail. It opens in the bottom region. A deployment can switch it off with the `data.schedule` feature (see [Configuring a Deployment](./viewer-deployment-config.md)).

## Where the schedule comes from

- **From the model.** When the file contains `IfcTask` entities, the panel reads them with their `IfcTaskTime` dates, `IfcRelSequence` dependencies, assigned products (`IfcRelAssignsToProcess`) and `IfcWorkCalendar`. When the file has `IfcWorkPlan` containers, the panel lists each with its nested work schedules. IFC4 and IFC4X3 are supported. For IFC2X3 files, tasks come without dates and work calendars are not read.
- **Generated.** **Generate schedule…** builds one from the model itself (below).
- **Imported.** **Import schedule…** reads an MS Project XML (MSPDI) file or a Gantt CSV export. See [Schedule Import](./schedule-import.md). Importing replaces the current schedule and its undo history. When the current schedule has edits or tasks read from the model, the panel asks first; otherwise the import applies at once.

A model without tasks opens on an empty state that offers **Import schedule…**, and **Generate schedule** when the model has a spatial structure or geometry to group.

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
| Add an `IfcWorkPlan` container | off. When on, a **Work plan name** field appears (default `Project plan`). |

The dialog previews the task range before you generate. Generating fills the panel and turns 4D animation on; playback stays paused until you press play. The schedule belongs to the model that was active when you generated it. It lives in the viewer until you export that model to IFC, which writes the generated or edited schedule into the file. Exports of other models in a federated session do not get it.

## Editing

- Drag a task bar to move it, or drag its ends to change the start or finish. The tooltip shows the new dates and duration. Hold Shift to turn off snapping. Press Esc to cancel.
- **Add task** inserts a task after the selected one, or at the end.
- Undo and redo apply to schedule edits only (Ctrl/Cmd+Z while the panel is active, or the toolbar buttons).
- Selecting tasks highlights their products in 3D.

Edits stay in the viewer until you export the model to IFC, which writes them into the file.

## Timeline and playback

The toolbar sets the time scale (hour, day, week, month, year; default week), jumps to the start or finish, plays or pauses, loops, and sets the speed in days, weeks or months per second. Playback starts paused, at 1 week per second, with looping on. The playback position can also be dragged. A model without real dates gets a synthetic range, marked **No dates**.

When the schedule has an `IfcWorkCalendar`, the timeline header shows a **Respect work calendar** toggle (on by default). With it on, non-working days of the active work schedule's calendar are shaded at day and week scale, and playback skips them. A schedule without real dates is never skipped.

### 4D animation settings

The animation settings popover controls how playback changes the 3D view:

- **Style.** **Minimal** changes visibility only. **Phased** paints colour overlays by task type (the `IfcTaskTypeEnum` value), with an editable palette.
- **Timing.** **Hide upcoming products**, **Hide unscheduled products** (products in no task), and **Animate demolition** (remove products when demolition tasks finish).
- **Colour overlays** (Phased only). **Colour by task type**, a **Preparation ghost** that dims products inside the **Look-ahead window**, **Tint completed products**, and **Colour intensity**. Intensity scales only the task-type colour: at 0 % no task-type colour is painted, but the preparation ghost and the completed tint still show when they are on. At 100 % the colour is painted at the palette's own opacity, still faded in and out at the start and end of each task.

**Reset defaults** restores the defaults: **Minimal**, a two-day look-ahead window, the three timing options on and every colour overlay off. Choosing **Phased** turns on task-type colour at 60 % intensity.

## Related

- [Charts](./charts.md) can chart schedule tasks and follow the 4D playback.
- Scripts read the schedule through `bim.schedule.data()`, `tasks()`, `workSchedules()` and `sequences()` (see [Scripting SDK](./scripting-sdk.md)).
