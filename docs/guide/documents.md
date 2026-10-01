# Documents

The **Document** panel is a page over the model: text whose fields read the loaded IFC, a logo, charts from your dashboards, BCF topics — laid out top to bottom and printed to an A4/A3 PDF. A document is a **template**: it stores the *bindings*, not the values, so the same document opened on the next revision of the file reads that revision. It lives in the bottom strip next to Charts (**Analyze → Document**, or `Document` in the command palette).

## Blocks

| Block | What it holds | In the PDF |
|-------|---------------|------------|
| **Text with fields** | `title`, `heading`, `subheading`, `body`, `small` or `caption` text; optional Helvetica, Times or Courier font and 6–48 pt size; free RGB text and background colours; `Full` or `Half` width. `{path}` placeholders resolve against the model (below). *Insert field* drops one at the caret: project, site, storeys, the selected element's attributes and property values. | Wrapped, paginated; a heading never sits alone at the bottom of a page |
| **Image / logo** | A PNG or JPEG (≤ 1 MB, stored in the document so the file travels), height in points, alignment, caption, width (`Full` or `Half`) | At its aspect ratio |
| **Chart** | A copy of a chart from one of your dashboards (see [Charts](./charts.md)), optionally with a 3D snapshot of its largest bucket, height in points (120-600, default 220), width (`Full` or `Half`), and text size (6–24, default 12) | The same vector chart the coordination report prints, with a legend that wraps and truncates instead of clipping |
| **BCF topic** | A topic by GUID — status, type, priority, assignee, dates, description — optionally with its first viewpoint snapshot | Text and image side by side |
| **Spacer** | Blank vertical space, height in points | Advances the page by its height; no other content |
| **Page break** | Starts the following content on a new page | Separates full-width content and half-width rows; leading, trailing and repeated breaks do not create empty pages |
| **Table** | A copy of a [list](./lists.md) — entity types, conditions, columns, grouping — re-run on the loaded models whenever the document is shown or printed; a title (the list's name by default), a caption, and how many rows to print (50 by default, up to 500) | Head + rows, the way the list's own export prints them: unit-converted cells with the unit in the column label, group rows with count and sums or the schedule view, a totals row when something is summed. A longer table continues on the next page with the head repeated; past the row cap it ends with `… n more rows` |
| **Manual validation report** | A frozen snapshot of the checklist in **Data validation → Manual validation** and one model's answers: every group and check with its verdict (Pass, Fail, Warning or Not checked), comment and guidance, and the counts per group. **Refresh from current checklist** takes a new snapshot of the same model's answers: the block remembers which model it was taken from (by the file identity its answers are stored under, not by name) and says so when that model is not loaded instead of reading another's. With several models loaded, **Answers from** picks a different model for the next refresh | A heading, an overall ring with the counts in words, then each group with its ring and its checks, each verdict printed as a word (`PASS`, `WARNING`, …) |

Each content block has an optional **Block title** (**Table title** for tables). It replaces the heading shown in preview and PDF without changing the chart, BCF topic, list, validation source or checklist name. Text and images gain a heading above their content; an image caption remains separate. Clear the field to restore the original heading. Titles travel with the document and remain when you refresh or replace a report source. Spacers and page breaks retain their layout-only controls.

Adjacent text, chart, or image blocks set to `Half` width print two-up on the same row. An unpaired `Half` block prints full width. Long text continues through the normal paginated text path when a two-column row would exceed the page height. BCF topic blocks are full width.

**Text colour** and **Background colour** accept any RGB colour through the colour picker. The background fills the text block’s full or paired half width and continues on each PDF page when the text wraps. Reset restores the style’s text colour or clears the background. Both colours travel with the saved document and exported template.

The preview on the right resolves fields against the loaded models; click a block on either side to select it. Explicit page breaks show separate paper sections in the preview. The PDF also paginates content that overflows a section; the preview stretches that section to show its content. Charts use the same SSR rendering in preview and PDF, including legend wrapping.

Each chart block has a **Text size** control. Smaller text makes room for longer axis labels and tighter legend rows; the renderer measures and fits the selected font before drawing. The setting scales chart titles, subtitles, axes, legends, pie/treemap labels and the count display while retaining their relative sizes. It is saved with the block and applies to both preview and PDF. Clear the field or use **Reset chart text size** to restore the existing default appearance.

## Bindings

A field is a path in braces. Names are the exact IFC names, case-sensitive.

Use double braces for literal text: `{{Today}}` prints `{Today}` without resolving a field. Generated workflow covers escape captured names this way, so file and workflow names retain their original spelling.

Choose a model in **Source** before using **Insert field** to bind that insertion to the named model. Each inserted field keeps its source when you change the active model or choose another source for the next field. For example, `{Model["Architecture.ifc"].IfcProject.Name}` reads the architecture model's project, and `{Model["Structure.ifc"].Count[IfcWall]}` counts walls only in the structure model. Selected-element properties are offered when that element belongs to the chosen source model. **Default source** retains the existing active-model fields and federation-wide counts.

Model-qualified fields use the exact model name, so they survive a reload with the same filename and new session ids. A missing model or duplicate model name is reported as unresolved. Give models distinct names to select a unique source; loading a renamed revision requires updating its named fields.

| Path | Reads |
|------|-------|
| `{IfcProject.Name}` `{IfcProject.LongName}` `{IfcProject.Description}` `{IfcProject.GlobalId}` | The project — also `IfcSite` and `IfcBuilding` (the first one) |
| `{IfcBuildingStorey["Level 1"].Name}` … `.LongName` `.Elevation` `.Elements` `.GlobalId` | A storey by name, or `IfcBuildingStorey[2]` by 1-based position |
| `{Element[2Ndyd$OSX7s9A04nc41yye].Name}` … `.Description` `.Type` `.ObjectType` `.Tag` `.GlobalId` `.Storey` | An element by GlobalId, in any loaded model |
| `{Element[…].Pset_WallCommon.FireRating}` | A property (or quantity) of that element, own or inherited from its type |
| `{Count[IfcWall]}` | Elements of a class across the loaded models |
| `{Model.Name}` `{Model.Schema}` `{Model.Elements}` `{Model.Count}` | The active model's file name and schema, the element count across loaded models, the number of loaded models |
| `{Model["Architecture.ifc"].IfcProject.Name}` | A project field from one named model; the same prefix scopes storey, element, property and class-count fields |
| `{Model["Architecture.ifc"].Name}` … `.Schema` `.Elements` `.Count` | Model metadata scoped to that model (`Count` is 1) |
| `{Today}` | The date |

A binding the model cannot answer is never printed as an empty string: the preview marks it and the PDF prints `[path: reason]` — `no IfcBuildingStorey "Roof"`, `no element with GlobalId …`, `no Pset_WallCommon.LoadBearing on this element` — and the export toast counts them. Elements and topics are addressed by GlobalId, which is what survives a new IFC revision; a topic block over a BCF file that is not loaded says so in place.

## Templates

Documents persist in the browser like dashboards. The **⋯** menu renames, duplicates, deletes, exports the document as an `.ifclite-document.json` file or imports one; an imported document gets fresh ids and keeps its bindings — that is the template. *New from preset* adds a **Blank page** (a title reading `{IfcProject.Name}`) or a **Cover sheet** (project, site, building, storey and element counts, an elements-by-type chart, the date). Page size and orientation are part of the document.

Expand **Page heading** to edit the text printed at the top of every page independently of the document's library name. Choose Helvetica, Times or Courier, a size from 6 to 48 points, and a text colour. Preview, PDF and exported document templates retain these settings. Long headings stay on one line and are truncated to the printable width; larger headings reserve additional space above the page content. **Reset page heading** restores the library name and original small grey heading.

Each grouped list table has its own **Group order**: **Largest first** (the default, by member count with stable label ties) or **By label**. The choice applies at every nesting level and to schedule rows before the printed-row limit. Two blocks over the same list can choose different orders without rerunning the list. Ungrouped tables retain the list's saved row order.

**Header background** chooses an opaque RGB colour for any document table. **Header text** optionally overrides the automatically chosen black or white ink; reset it to return to readable contrast for the current background. Resetting the background restores the default slate. Both colours appear in preview and on every repeated PDF header, and persist with the document; older documents keep the automatic text colour.


The file is `version: 10`; versions 1–9 open and re-save as version 10 automatically (version 8 added page breaks, version 9 added saved comparison table sources, and version 10 adds live manual checklist sources and presentation options). Older viewers refuse a newer file with a clear version error. A table block embeds its list (lists otherwise live only in the browser), so a shared document brings its tables along; the copy never carries a selection snapshot (`expressIdsByModel`), which is bound to one load of one model. More than two columns per row, arbitrary font files, a per-chart legend position, page margins, and drag-resize are not currently available.

### Validation result rings

IDS and information validation results show a ring with the completed run’s pass, warning and failure counts. The percentage is the validation engine’s pass rate; a failed cardinality requirement can keep that rate at zero even when individual elements pass. An empty result keeps the engine’s no-applicable-elements verdict. Information-validation warning failures have their own amber segment and are excluded from the red failure count. The legend names each outcome, so color is not the only cue.

New IDS and information-validation document blocks include the ring. **Show benchmark scores** toggles it in both the preview and PDF, for **Compact**, **Long**, and existing classic layouts. Refreshing a result or selecting another saved report preserves this choice. Older documents retain their existing output until you enable the control. The ring uses the embedded result’s original counts and does not rerun validation or save a report.

### Saved validation reports

IDS and information validation checks show their results without adding to history. Choose **Save report** in the results toolbar to retain a completed check in **Data validation → Saved reports**, including the names and source fingerprints of the models evaluated when that check finished. Saving the same result again does not duplicate it; a later run can be saved separately. In Manual validation, **Save report** records the currently selected model's checklist answers. Rename or remove saved reports from the history. Reports are stored in this browser; a storage failure displays a warning before you reload. Unreadable history has a separate notice: the original data is preserved before valid reports are recovered, or saving stays blocked if a backup is unavailable. **Retry save** keeps your current in-memory reports. A successful retry also restores reports discovered after a temporarily unavailable read; reports you explicitly removed stay removed.

Use **Add block → Saved validation report** in Documentation, then choose the specific report in **Saved report source**. Each block embeds a copy of that result with its original model scope. Later checks, model removal, or deleting a report from history do not alter an existing document. Saved evidence does not apply historical entity identifiers to the current 3D scene. Live checklist editing remains separate from saved report snapshots.

### Saved model comparisons

In **Compare models**, run a model pair and select **Save comparison**. Each save
creates a separate named report: compare A/B, then A/C, then B/C without losing
previous results. Saved comparisons retain all canonical change rows, model-pair
provenance, product/type counts, excluded IFC classes and geometry limitations.
They persist in this browser after model unloading or reloading. Renaming affects
only the library name. Historical report rows never select elements in a newly
loaded model; rerun the pair for current 3D review.

Chart blocks can also use a dashboard chart bound to a specific **Saved
comparison**. Preview and PDF use that recorded report's rows and suppress
3D snapshots. A chart block retains the comparison ID rather than embedding
history, so deleting its saved source or opening the file in another browser
without that source displays an explicit unavailable-source message. Choose
another bound dashboard chart in the block editor to replace it. See
[saved comparison charts](./charts.md#saved-comparison-charts) for the binding
and import behavior; saved comparison table blocks continue to embed their
own evidence.

In Documentation, **Add block → Saved comparison** embeds the first saved report.
Select the block and choose another saved comparison in its source picker. The
preview and PDF show the selected pair's provenance, summary and change table.
The table's **Rows** setting limits printed rows with an explicit omitted-row
count; CSV and JSON downloads from Compare retain the complete saved report.
A no-change comparison prints its summary and an explicit no-changes message.

Documents embed a copy of the report, so deleting or renaming its library entry
does not alter an issued document. Export the document JSON to share that copy.
Saved comparison history is local to this browser; storage failures show a warning
and leave the report available in memory for download before closing the tab.
If history cannot be read, the library and document source picker show a notice.
Invalid or duplicate history is backed up before valid reports are restored.
When the backup cannot be written, the original remains untouched and saving is
blocked; free browser storage and retry saving. Retry retains in-memory edits
and reports whether the browser now saved them.
Document format 9 adds comparison table sources; older documents remain readable.

### Live manual checklists

In **Data validation → Manual validation**, **New checklist** creates another independently editable checklist. Use **New from this checklist** to reuse the same questions in a new review with empty decisions. Name it for its discipline and use **Select checklist** to switch between reviews. Each checklist keeps its own decisions and comments for each model; importing templates with the same check identifiers does not share their answers. The selector shows completion for the currently selected model. A warning completes a check, while the report's pass score still counts only passes.

**Close checklist** leaves the review in the selector for later. Reopening the same saved template selects its existing review and decisions. **Delete checklist** removes that editable review; previously saved reports and document snapshots remain unchanged. Existing open checklists and their decisions migrate automatically. Decisions retained after an older checklist was closed are kept until an imported template supplies matching check identifiers. The old data contains no template or discipline identity, so that recovery cannot establish which discipline originally supplied a decision; unmatched decisions remain available for another template. If browser storage refuses a write, the current review remains visible with a warning.

In Documentation, a manual report’s **Checklist** selector chooses the specific review without changing the checklist open in Data validation. **Refresh from current checklist** reads that chosen review and the block’s selected model. Choose **Long** to print guidance and comments, or **Short** for questions and verdicts. **Show benchmark scores** controls the progress rings and numerical summaries in both preview and PDF. A report still embeds its last snapshot: deleting the live checklist leaves its printed evidence intact and disables Refresh. Older manual blocks retain their original detailed layout and active-checklist refresh behavior until you select a specific source.


## Workflow report documents

[Session automation](flow.md#file-slots-reports-and-portability) builds documents
from completed validation, rerun comparisons and imported historical comparison
evidence. Default documents show run/model provenance before native report blocks.
Templates use explicit block-to-job/result mappings; multi-model IDS jobs expand
into adjacent report blocks while retaining title, ring and layout settings.

Flow awaits native list and chart-filter preparation before producing a combined
PDF. Renderer warnings and row-limit notices remain visible. Documents use the
existing version-10 native format and remain editable in Documentation. A storage
warning means the document remains available in memory. Download retries reuse
the current PDF artifact rather than rerunning checks.
