# Documents

The **Document** panel is a page over the model: text whose fields read the loaded IFC, a logo, charts from your dashboards, BCF topics — laid out top to bottom and printed to an A4/A3 PDF. A document is a **template**: it stores the *bindings*, not the values, so the same document opened on the next revision of the file reads that revision. It lives in the bottom strip next to Charts (**Analyze → Document**, or `Document` in the command palette).

## Blocks

| Block | What it holds | In the PDF |
|-------|---------------|------------|
| **Text with fields** | `title`, `heading`, `subheading`, `body`, `small` or `caption` text; optional Helvetica, Times or Courier font and 6–48 pt size; `Full` or `Half` width. `{path}` placeholders resolve against the model (below). *Insert field* drops one at the caret: project, site, storeys, the selected element's attributes and property values. | Wrapped, paginated; a heading never sits alone at the bottom of a page |
| **Image / logo** | A PNG or JPEG (≤ 1 MB, stored in the document so the file travels), height in points, alignment, caption, width (`Full` or `Half`) | At its aspect ratio |
| **Chart** | A copy of a chart from one of your dashboards (see [Charts](./charts.md)), optionally with a 3D snapshot of its largest bucket, height in points (120-600, default 220), width (`Full` or `Half`) | The same vector chart the coordination report prints, with a legend that wraps and truncates instead of clipping |
| **BCF topic** | A topic by GUID — status, type, priority, assignee, dates, description — optionally with its first viewpoint snapshot | Text and image side by side |
| **Spacer** | Blank vertical space, height in points | Advances the page by its height; no other content |
| **Table** | A copy of a [list](./lists.md) — entity types, conditions, columns, grouping — re-run on the loaded models whenever the document is shown or printed; a title (the list's name by default), a caption, and how many rows to print (50 by default, up to 500) | Head + rows, the way the list's own export prints them: unit-converted cells with the unit in the column label, group rows with count and sums or the schedule view, a totals row when something is summed. A longer table continues on the next page with the head repeated; past the row cap it ends with `… n more rows` |

Adjacent text, chart, or image blocks set to `Half` width print two-up on the same row. An unpaired `Half` block prints full width. Long text continues through the normal paginated text path when a two-column row would exceed the page height. BCF topic blocks are full width.

The preview on the right is the page resolved against the loaded model; click a block on either side to select it. What the preview shows is what prints — the same SSR chart rendering, including the legend wrapping.

## Bindings

A field is a path in braces. Names are the exact IFC names, case-sensitive.

| Path | Reads |
|------|-------|
| `{IfcProject.Name}` `{IfcProject.LongName}` `{IfcProject.Description}` `{IfcProject.GlobalId}` | The project — also `IfcSite` and `IfcBuilding` (the first one) |
| `{IfcBuildingStorey["Level 1"].Name}` … `.LongName` `.Elevation` `.Elements` `.GlobalId` | A storey by name, or `IfcBuildingStorey[2]` by 1-based position |
| `{Element[2Ndyd$OSX7s9A04nc41yye].Name}` … `.Description` `.Type` `.ObjectType` `.Tag` `.GlobalId` `.Storey` | An element by GlobalId, in any loaded model |
| `{Element[…].Pset_WallCommon.FireRating}` | A property (or quantity) of that element, own or inherited from its type |
| `{Count[IfcWall]}` | Elements of a class across the loaded models |
| `{Model.Name}` `{Model.Schema}` `{Model.Elements}` `{Model.Count}` | The active model's file name and schema, its element count, the number of loaded models |
| `{Today}` | The date |

A binding the model cannot answer is never printed as an empty string: the preview marks it and the PDF prints `[path: reason]` — `no IfcBuildingStorey "Roof"`, `no element with GlobalId …`, `no Pset_WallCommon.LoadBearing on this element` — and the export toast counts them. Elements and topics are addressed by GlobalId, which is what survives a new IFC revision; a topic block over a BCF file that is not loaded says so in place.

## Templates

Documents persist in the browser like dashboards. The **⋯** menu renames, duplicates, deletes, exports the document as an `.ifclite-document.json` file or imports one; an imported document gets fresh ids and keeps its bindings — that is the template. *New from preset* adds a **Blank page** (a title reading `{IfcProject.Name}`) or a **Cover sheet** (project, site, building, storey and element counts, an elements-by-type chart, the date). Page size and orientation are part of the document.

The file is `version: 6`; versions 1–5 open and re-save as version 6 automatically. Older viewers refuse a newer file with a clear version error. A table block embeds its list (lists otherwise live only in the browser), so a shared document brings its tables along; the copy never carries a selection snapshot (`expressIdsByModel`), which is bound to one load of one model. More than two columns per row, arbitrary font files or text colour, a per-chart legend position, page margins, and drag-resize are not currently available.
