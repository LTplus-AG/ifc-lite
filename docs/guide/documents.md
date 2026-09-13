# Documents

The **Document** panel is a page over the model: text whose fields read the loaded IFC, a logo, charts from your dashboards, BCF topics — laid out top to bottom and printed to an A4/A3 PDF. A document is a **template**: it stores the *bindings*, not the values, so the same document opened on the next revision of the file reads that revision. It lives in the bottom strip next to Charts (**Analyze → Document**, or `Document` in the command palette).

## Blocks

| Block | What it holds | In the PDF |
|-------|---------------|------------|
| **Text with fields** | Title, heading or body text; `{path}` placeholders resolve against the model (below). *Insert field* drops one at the caret: project, site, storeys, the selected element's attributes and property values. | Wrapped, paginated; a heading never sits alone at the bottom of a page |
| **Image / logo** | A PNG or JPEG (≤ 1 MB, stored in the document so the file travels), height in points, alignment, caption | At its aspect ratio |
| **Chart** | A copy of a chart from one of your dashboards (see [Charts](./charts.md)), optionally with a 3D snapshot of its largest bucket | The same vector chart the coordination report prints |
| **BCF topic** | A topic by GUID — status, type, priority, assignee, dates, description — optionally with its first viewpoint snapshot | Text and image side by side |

The preview on the right is the page resolved against the loaded model; click a block on either side to select it. What the preview shows is what prints.

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
