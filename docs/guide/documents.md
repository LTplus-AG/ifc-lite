# Documents

The **Document** panel is a page over the model: text whose fields read the loaded IFC, a logo, charts from your dashboards, BCF topics — laid out top to bottom and printed to an A4/A3 PDF. A document is a **template**: it stores the *bindings*, not the values, so the same document opened on the next revision of the file reads that revision. It lives in the bottom strip next to Charts (**Analyze → Document**, or `Document` in the command palette).

Use **Page heading** and **Page footer** to set the text, standard font, text size and ink independently of the library document name. Each band can embed a PNG/JPEG logo, show the captured local date and show the current page and total. A logo uses the same 1 MB upload limit as a body image and travels in the document file. **Reset page footer** restores the generated receipt and page counter; resetting the heading restores the library name.

The shared composer reserves the measured bands before laying out body blocks. Preview and PDF repeat the same text, logo and truthful counters on explicit page breaks and pages created by text or tables overflowing. If an enlarged block heading cannot fit between the bands, reduce the band height or block size before exporting.

## Blocks

Use **Copy block** beside the move and remove buttons to place an independent copy immediately after any block. The copy keeps its text, formatting, fields and source references, and is selected for editing. Editing or removing it leaves the original unchanged.

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

The same row of controls sits under every title field, on every block with a heading: **Title size (pt)** (6 to 24, blank for the default 11), **Title colour** and **Title background**, each with a reset. The heading follows the block, so a block at 200 % prints a heading twice as large and twice as tall. A larger heading makes the block taller and the content below it moves down; a heading never pushes a block out of the printable frame. With only a background chosen, the heading text is black or white, whichever contrasts better; a colour you choose is never changed, but a note under the controls warns when the title colour falls below WCAG AA contrast on its background (4.5:1, or 3:1 for a title printing at 14 pt or larger, block size included), or on white paper without one. On a background the title's capitals are centred in the strip. Text size for the content under a heading is the block's own **Text size** where it has one (text blocks, charts) and **Block size (%)** for every other block. The settings are saved with the block in the document file and its exported template, and are kept when a report block is refreshed, replaced from a saved report or filled from a workflow. They style the block's title and are separate from a table's **Header background** and **Header text**, which colour its column-header row. A file without them prints exactly as before; they need no new document version because an older viewer simply prints the plain heading.

Every block with text or graphics (text, image, chart, BCF topic, table, IDS or rule-set report, manual validation report) has a **Block size (%)** field, 50 to 200, blank for 100. One factor scales the block's text and graphics together, so a chart keeps the proportion between its plot and its labels at any size. The text re-wraps at its new size and a table or report paginates by its larger rows. Spacing between blocks does not scale. It multiplies the block's own settings (text size, chart height and text size, image height) rather than replacing them. Spacers keep their height field and page breaks have no size.

Adjacent text, chart, or image blocks set to `Half` width print two-up on the same row. An unpaired `Half` block prints full width. Long text continues through the normal paginated text path when a two-column row would exceed the page height. BCF topic blocks are full width.

**Text colour** and **Background colour** accept any RGB colour through the colour picker. The background fills the text block’s full or paired half width and continues on each PDF page when the text wraps. Reset restores the style’s text colour or clears the background. Both colours travel with the saved document and exported template.

The preview on the right resolves fields against the loaded models and uses the same page composer and font measurements as PDF export. Content that overflows a page continues on another sheet; explicit page breaks, repeated table headers, page headings, footers and page counters follow the same layout in both. Select a block on either side, or select its continuation on a later preview page, to edit the original block. Charts use the same SSR rendering in preview and PDF, including legend wrapping.

Each chart block has a **Text size** control. Smaller text makes room for longer axis labels and tighter legend rows; the renderer measures and fits the selected font before drawing. The setting scales chart titles, subtitles, axes, legends, pie/treemap labels and the count display while retaining their relative sizes. It is saved with the block and applies to both preview and PDF. Clear the field or use **Reset chart text size** to restore the existing default appearance.

PDF export captures the interface language when it starts. Generated table and validation labels, footers and page counters keep that language throughout export, including while images are prepared. Generated French counts use a PDF-supported nonbreaking grouping space, keeping the grouped digits intact. Authored text keeps its own wording. Callers that omit a captured label context retain the existing English PDF labels.

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


The file is `version: 13`; versions 1–12 open and re-save as version 13 automatically (version 8 added page breaks, version 9 added saved comparison table sources, version 10 added live manual checklist sources and presentation options, version 11 added the optional block size, version 12 added repeated header/footer options, and version 13 preserves captured embedded List populations). Older viewers refuse a newer file with a clear version error. A table block embeds its list (lists otherwise live only in the browser), so a shared document brings its tables along; the copy drops the load-specific selection snapshot (`expressIdsByModel`). A captured selected or visible population instead keeps source content identity and element membership, so the table replays those elements after the same files reload. Missing, replaced, ambiguous, or deleted members refuse execution and require an explicit recapture; they do not widen the table to all matching elements. More than two columns per row, arbitrary font files, a per-chart legend position, page margins, and drag-resize are not currently available.

### Validation result rings

IDS and information validation results show a ring with the completed run’s pass, warning and failure counts. The percentage is the validation engine’s pass rate; a failed cardinality requirement can keep that rate at zero even when individual elements pass. An empty result keeps the engine’s no-applicable-elements verdict. Information-validation warning failures have their own amber segment and are excluded from the red failure count. The legend names each outcome, so color is not the only cue.

With the **Compact** layout selected, **Specifications only** prints one bar row per specification with its pass rate and leaves out the requirement rows, in both the preview and PDF, shortening reports with many requirements. Refreshing a result or selecting another saved report keeps this choice. The option is stored as an optional field of the block; an older viewer that supports document version 11 ignores it and prints the full compact report.

New IDS and information-validation document blocks include the ring. **Show benchmark scores** toggles it in both the preview and PDF, for **Compact**, **Long**, and existing classic layouts. In the **Compact** layout each specification is a bold row that opens a group, and its requirements are indented beneath it, with more space before the next specification, in both the preview and the PDF. Refreshing a result or selecting another saved report preserves this choice. Older documents retain their existing output until you enable the control. The ring uses the embedded result’s original counts and does not rerun validation or save a report.

**Show stamp information** controls the two rows below an IDS or information-validation report's title in both the preview and the PDF: **Validation run**, the time the run finished, and **Models**, the names of the models it evaluated. Turn it off to omit both; the recorded time and model names remain in the saved document, and a report that recorded no models never prints a **Models** row. Refreshing a result or selecting another saved report preserves this choice, as do workflow-built report documents (a block's choice in the template, or a saved report's own). Existing documents show their stamp until you turn it off.

### Saved validation reports

IDS and information validation checks show their results without adding to history. Choose **Save report** in the results toolbar to retain a completed check in **Data validation → Saved reports**, including the names and source fingerprints of the models evaluated when that check finished. Saving the same result again does not duplicate it; a later run can be saved separately. In Manual validation, **Save report** records the currently selected model's checklist answers. New IDS and information-validation reports retain up to 2,000 failed/warning element rows, within a 1 MiB evidence budget, including exact IFC GlobalIds, evaluated model names and native requirement details. Larger or incomplete captures disclose omitted rows and unknown remaining counts; the native report summary remains intact. Saved reports expose these facts in history and Review. Open original in Review selects the exact saved row, including a row beyond the first 50 shown. Older count-only snapshots remain usable without invented element details. Rename or remove saved reports from the history. Reports, saved comparisons, and documents are stored individually in this browser’s IndexedDB. They no longer share the small `localStorage` quota used by viewer preferences. **Saving changes…** means a write is pending; **Changes saved in this browser** appears after the database transaction completes. A refused save leaves your draft available in this tab and explains whether storage is full, unavailable, or another tab changed the item. **Retry save** keeps the same IDs and your current drafts. Browser storage still has capacity and eviction limits; keep exported backups for important work.

For a saved manual report, **Edit a copy** opens an independent editable checklist with its recorded decisions, comments and guidance. Load the same source file first: the copy follows its stored fingerprint after reload, even when another model is active. A report without a recorded model identity remains readable but cannot supply an editable copy. Editing, repeating the copy, or deleting its live checklist leaves the saved report unchanged. If its model is removed, answer controls stay disabled until that source is loaded again or you explicitly choose another model for a separate review. Browser storage failures leave the current copy editable with a visible warning.

**Add block → Validation report** in Documentation is the one entry for IDS, information-validation and manual reports. It adds the most recently saved report, whatever its kind; with nothing saved yet, it adds the current IDS or information validation run, or else the current manual checklist, so the entry is available as soon as any of those exists. Then choose the specific report in **Saved report source**: that one list holds every saved report, and, while they exist, **Current IDS validation run (live)**, **Current information validation run (live)** and **Current manual checklist (live)**. Switching source keeps the block's title, size and layout choices. A live choice shows **Refresh** on the block; a saved report never changes. Each block embeds a copy of that result with its original model scope. Later checks, model removal, or deleting a report from history do not alter an existing document. Saved evidence does not apply historical entity identifiers to the current 3D scene. Live checklist editing remains separate from saved report snapshots.

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
own evidence. Recorded-source provenance remains an informational caption;
missing history, refused filters and aggregation errors are reported as PDF
export problems.

A chart block can likewise use a dashboard chart bound to a **saved clash
report**. Preview and PDF show the saved run rather than the current result,
print which report it is and whether the run was partial or recorded on another
model revision, and take no 3D snapshot. The block keeps the report's ID, so
a deleted report, or a file opened where the report does not exist, prints
**Saved clash report unavailable** and is reported as a PDF export problem. See
[saved clash report charts](./charts.md#saved-clash-report-charts).

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

**Show stamp information** controls the model name, recording time and evaluated-model names below a manual report’s title in both preview and PDF. Turn it off to omit those rows; the recorded identity, timestamp and answers remain in the saved document. Refreshing or choosing another manual saved report preserves this display choice. Existing documents show their stamp until you turn it off.


## Workflow report documents

[Session automation](flow.md#file-slots-reports-and-portability) builds documents
from completed validation, rerun comparisons and imported historical comparison
evidence. Default documents show run/model provenance before native report blocks.
Templates use explicit block-to-job/result mappings; multi-model IDS jobs expand
into adjacent report blocks while retaining title, ring and layout settings.

Flow awaits native list and chart-filter preparation before producing a combined
PDF. Renderer warnings and row-limit notices remain visible. Documents use the
existing native format (a workflow template saved at an older version is upgraded when it is used) and remain editable in Documentation. A storage
warning means the document remains available in memory. Download retries reuse
the current PDF artifact rather than rerunning checks.

### Assistant report outlines

A [reviewed report outline](viewer-assistant.md#reviewed-ids-rule-and-report-drafts) from the viewer assistant is saved as a new document built from these blocks: a title, an AI-draft notice, section headings, literal text, validation-results tables bound to the live report (optionally to one specification or rule), an optional validation report snapshot and page breaks. A requirement the outline lists as unsupported is kept in a closing **Not covered by this report** section. After saving, the document is edited and printed like any other.

### Storage, backup, and migration

Each saved-content library has **Storage and backup** controls. **Download library backup** downloads a self-contained JSON file with saved Filters, Lists and Lenses, validation reports, comparison reports, documents, and the current unsaved drafts. Captured artifact populations retain their file and element identities. Backups containing standalone artifact definitions use version 2; older viewers refuse that version. Empty artifact arrays alone retain version 1. Ordinary version-1 backups remain readable. Valid entries stay in its importable libraries. Incomplete drafts, such as an image block awaiting its image, are preserved separately as raw JSON recovery evidence, so they never prevent valid neighboring entries from being imported. Save-status metadata identifies drafts that have not reached browser storage. Downloading saved libraries and current drafts works even when browser storage refuses writes. An unfinished standalone backup import blocks whole-library download to prevent omitting its unsaved entries; keep the original file, retry after freeing storage or removing unused Filters, or explicitly cancel the unfinished import. Individual document **Export template** and **Export PDF** remain available.

**Import library backup** validates the entire file before writing. Reports, documents and the other IndexedDB libraries save their valid entries and raw draft evidence in one transaction. Standalone Filters, Lists and Lenses then save through their native browser libraries. Those separate writes are not one transaction: if one fails, already saved libraries remain saved, the refused library remains unchanged, and a warning asks you to keep the backup file and use **Retry all libraries** before closing the tab. Identical existing entries are retained; independently saved Lists and Lenses retain distinct IDs even when their names and criteria match. Conflicting IDs are imported as independent copies. Repeating a complete import keeps unchanged List and Lens copies without duplicates. Filters use their native names as identities: importing a conflicting Filter again as a separate file import creates another independent copy. Missing standalone Filters, Lists and Lenses can be restored from an explicit backup import; the other saved-content libraries retain their deleted-import tracking. Raw incomplete drafts are archived for recovery and do not enter the editable libraries. **Download preserved originals** exposes each draft's library kind, original ID, and unchanged raw JSON for inspection or recovery; finish its incomplete fields before importing it as a normal document or report. Further library backups include these archived drafts too. If storage refuses the import, both its valid entries and raw evidence remain in this tab so you can export or retry them. A notice identifies session-only evidence. If archived evidence cannot be read during export, the viewer still downloads the content available in this tab and warns you to keep earlier backups.

**Retry save** retries this library. **Retry all libraries** retries pending writes in the saved-content libraries, the standalone artifact libraries and any raw recovery evidence; use it after a refused backup import so that linked report sources and incomplete drafts are also retained. The retries preserve each draft’s ID and report bindings. One backup action owns this tab across panel close/reopen, preventing overlapping imports. Newly saved durable List and Lens peers from other tabs are included; a conflicting same-ID local draft refuses export/import until refreshed. Only unfinished standalone entries remain pending in this tab across panel close/reopen, so Retry does not copy Filters that already saved. A matching List draft stays pending until it saves successfully. If any write still fails, the viewer reports that some content remains unsaved. **Cancel unfinished import** asks for confirmation, keeps entries already saved and releases whole-library download and import; recover the cancelled unsaved entries from the original backup file.

An edit in another tab cannot silently overwrite your document. A conflict keeps your local draft. Export it, duplicate the document as a new copy, or choose **Reload saved versions** to explicitly discard this library’s unsaved changes and reopen the persisted versions. A failed reload leaves your drafts intact. Report copies already embedded in documents remain independent of the libraries.

Older `localStorage` libraries are automatically migrated. Their IDs, model scope, evidence dates, and document content are retained; invalid and duplicate entries produce a recovery notice. The complete original data and existing unreadable backups are preserved in IndexedDB. **Download preserved originals** retrieves those values for inspection or recovery. Interrupted migrations can be retried without duplicating entries or resurrecting deleted reports.

Legacy values are not removed automatically. Once migration succeeds, close older viewer tabs and choose **Remove migrated legacy copies** to reclaim their `localStorage` space. Only unchanged copies with preserved originals are removed. An older tab’s later writes are archived for recovery, rather than replayed over newer content. Older application versions do not read the new IndexedDB library; export your content before downgrading.

**Check storage usage** estimates the library payloads currently in this tab and the browser’s total usage and quota for this origin. Origin usage includes model caches and other site data; it is not the saved-library size.

**Protect browser storage** requests persistent storage from the browser. The browser may decline; saving still works. Persistent storage reduces automatic eviction risk, but clearing site data still deletes it. A different browser, device, or viewer origin has a separate library. Backups remain the portable way to transfer and retain your work. Model-cache cleanup does not delete saved reports or documents.
