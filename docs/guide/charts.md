# Charts

The **Charts** panel turns the loaded models into a dashboard of charts that stay bound to the 3D view: click a bar or a slice and its elements are selected in the model; pick an element in the model and the chart lights up the bucket it belongs to; the selection in one chart slices every other chart on the dashboard. It lives in the bottom strip next to Lists and Schedule (**Analyze → Charts**, or `Charts` in the command palette).

## What a chart is

A chart is a **dataset** plus a **spec**. The dataset has one row per thing being counted — an element, a clash pair, a topic — and every row carries the ids of the elements it stands for. The spec says how to bucket the rows:

| Field | Meaning |
|-------|---------|
| Chart | `bar`, `stackedBar`, `pie`, `treemap`, `histogram` (bins a number column), `timeline` (buckets a date column into ISO weeks), or `elementCount` (one row total) |
| Group by | The column whose distinct values become the buckets |
| Stack by | For a stacked bar: a second category column, one series per value |
| Measure | `count` of rows, or the `sum` of an independently chosen number column; Element Count always counts |
| Top N | Keep the N largest buckets and fold the rest into one grey **Other** bucket (which still carries every element it stands for) |
| Order | Largest first, or by label (dates and histogram bins are always chronological / ascending) |

Because a bucket keeps its element ids, the bidirectional link needs no support from the chart library: a click is `bucket → ids`, a 3D pick is `ids → buckets`. The headless half is the [`@ifc-lite/charts`](https://github.com/LTplus-AG/ifc-lite/tree/main/packages/charts) package, which the CLI and the PDF export share. Its public `Bucket.isOther?: true` flag identifies the synthetic top-N tail; consumers must use that flag instead of treating a literal category key such as `__other__` as synthetic.

## Sources and scope

| Source | One row per | Columns | A bucket selects |
|--------|-------------|---------|------------------|
| **Elements** | geometry-bearing element instance across every loaded model | `IFC type`, `Storey`, `Model`, `Name`, plus exact IFC fields chosen for grouping and measuring | the elements |
| **Clash results** | clash of the current run (after exclusions) | `Rule`, `Severity`, `Detection` (hard / clearance / touch), `Review status`, `Type A`, `Type B`, `Type pair`, `Model A`, `Model B`, `Storey`, `Distance` (m, for a penetration histogram), `Group` | both elements of every clash in it |
| **BCF topics** | topic of the loaded project | `Status`, `Type`, `Priority`, `Assigned to`, `Stage`, `Labels`, `Author`, `Due` (overdue / this week / later / none), `Age` (days), and the dates `Created`, `Modified`, `Due date`, `Closed` | the components of the topics' viewpoints that are loaded |
| **Schedule tasks** | task of the active schedule | `Task`, `Status`, `Phase at cursor` (not started / in progress / done, following the 4D playback), `Task type`, `Critical`, `Milestone`, `Duration` (days), `Products`, and the dates `Start`, `Finish` | the tasks' products |
| **IDS results** | (specification, entity) result of the last validation | `Specification`, `Result` (pass / fail), `Entity type`, `Failing facet`, `Model` | the entities |
| **Model compare** | diff entry of the last comparison | `State`, `What changed`, `IFC type`, `Revision` | the head-side entity (base-side for a deletion) |

Date columns feed the `timeline` chart, which buckets per ISO week — topics created or closed per week, tasks starting per week. There is no run history in the viewer, so BCF dates are the only time axis; clash counts over successive runs are not charted.

The dashboard's **scope** applies to the elements source and decides which elements its rows cover: all loaded models, only what is visible right now (the same answer the Lists panel's "visible only" gives), or the basket.

### Source filter

Every chart also has its own **Source filter**: the same [selector syntax](./selector-syntax.md) the search Filter tab's Selector field reads (`IfcWall`, `Pset_WallCommon.FireRating=/REI.*/`), typed once per chart and run on top of the dashboard scope. It is read and evaluated through the exact same path the Filter tab uses — there is no second matcher — so a chart's filter and a search filter never disagree about what an IFC class or property means.

Choose **Add rule** in the chart editor to build the source filter with the same rule controls as the search Filter tab. This includes Model Tag and other rules that have no selector spelling. An existing selector is converted to editable rules when every term can be read. Switching back to **Selector** fills the text field only when the rules have a faithful selector representation; otherwise it starts with an empty field. Saving a rule filter stores its rule groups in `filter.groups` and leaves `filter.selector` empty. Charts saved before this option continue to use their selector text.

The filter is **applicable to Elements, Clash results, Schedule tasks and IDS results**, and keeps a row if ANY of its elements matches (a clash keeps a row if either of its two elements matches; a schedule task keeps a row if any of its products matches, so a task with no matching product drops). It is **not applicable to BCF topics or Model compare** — a BCF row's "elements" are a viewpoint's component GUIDs (often none loaded) and a compare row straddles two revisions, so a selector has nothing well-defined to narrow; the editor disables the field for those two sources with a note, and a saved dashboard is refused if one carries a filter anyway.

Reading a chart's filter text uses the same all-or-nothing rule the rest of the selector adapter does (#4091's fix, applied here): a parse error, a selector with no filterable rule, or any construct this version cannot read yet is **refused outright** rather than run on the readable part — a chart that silently narrowed to what it understood would misreport its numbers with nothing on screen to say so. A chart with a filter still resolving, or one whose filter was refused, shows an empty chart with the reason in its subtitle instead of the unfiltered numbers; a successfully filtered card's subtitle names the filter (`6 buckets · 12 elements · filter: IfcWall`). A document's chart blocks resolve the same filters the dashboard panel does, so a printed report shows the same filtered numbers the panel shows.

### IFC fields: attributes, properties, quantities and relations

For an **Elements** chart, **Element field** can stay on the built-in columns or select one exact IFC field:

| Family | Picks | Value |
|--------|-------|-------|
| **IFC attribute** | the attribute's EXPRESS name (`ObjectType`, `OverallHeight`, …) | the occurrence's own attribute; only attributes the schema declares as scalar values are offered |
| **IFC property** | exact property-set and property names (`Pset_WallCommon.FireRating`) | the occurrence's property, else its defining type's |
| **IFC quantity** | exact `IfcElementQuantity` and quantity names (`Qto_WallBaseQuantities.NetVolume`) | a number in the project unit, summable and histogrammable; the occurrence's quantity, else its defining type's |
| **Material / classification / type / spatial** | `Material` (every associated material name, joined), `Type name` (the defining `IfcTypeObject` via `IfcRelDefinesByType`), `Classification` for any system or one discovered system (the reference's identification, else its name), and the `Container`, `Building`, `Site` or `Project` the element sits in | categories |

A **Filter** box narrows set and field names, so a model with hundreds of property sets stays pickable. Filter matching ignores case, but the selected names are the exact IFC names, including dots and slashes. For example, selecting `Pset_WallCommon.FireRating` makes its distinct values available to **Group by**; a consistently numeric property or any quantity can also drive **Sum** or a histogram. **Measure** independently offers discovered numeric IFC fields, so a chart can group by Material and sum `Qto_WallBaseQuantities.NetVolume`, or group by storey and sum area. Bar, stacked bar, pie, treemap, histogram and timeline charts use the same measure choice; Element Count remains a row count. A missing quantity contributes no volume and is reported in the card subtitle. Material grouping uses the element's material association and its element-level quantity: a multi-material element is grouped under the combined material label, not split into per-material volumes.

Occurrence properties take precedence. If the occurrence does not carry the selected property, its first defining type is consulted; an explicit empty/null occurrence value or a deleted property stays missing and suppresses inheritance. Attribute values are read only from the occurrence, and only attributes the loaded schema declares as scalar values are offered — a reference attribute (an `IfcDirection`, a placement) or a collection is not a value, whatever its STEP slot holds. `0`, `false`, and identifiers such as `"001"` remain real values.

A property's **shape** decides what it can be. An `IfcPropertySingleValue` is a scalar and, when typed as a measure, a number. An enumerated, list, bounded or table value is a shape, not a scalar: its display string (`A, B`, `5 [1 – 10]`) is a category it can be grouped by, and it is never summed — a one-member list is still a list and an upper bound alone is still a range.

Field kind and unit interpretation are saved in the dashboard document (version 2: adds the per-chart source filter above and drops a `list` scope kind a version-1 dashboard could carry; an older file is migrated on load), so temporarily unloading a model cannot reinterpret the chart. A saved field that is unavailable in the currently loaded federation remains selected and is labelled unavailable instead of being silently replaced. Property edits and deletions invalidate the data even when element ids and row counts do not change. The chart editor's own draft binds to a column of its own and never rebuilds the dashboard's datasets, so browsing fields cannot disturb another chart's live selection. Discovery merges what every loaded model exposes before deciding a field's kind, so a property that is numeric in one model and text in another is a category whichever model loaded first.

A numeric column is summed in **one unit**. Each value is converted into it from the unit it is actually in — the property's own explicit `Unit` when it declares one (converted by that unit's parsed scale, so a decimetre or a derived unit converts even without a curated display alternative), else the model's project unit assignment. A value whose unit cannot be established is reported as unsupported rather than guessed: a typed measure in a model that declares no unit for it, an explicit unit reference the file does not let the parser read, or a monetary amount in a currency other than the column's (there is no exchange rate to fold euros into dollars; the column takes the first model's currency). A sum subtitle reports rows without a measure and unsupported rows separately, so an all-missing field cannot look like a measured zero. Categories are unit-qualified instead (`1 mm` and `1 m` are different labels).

## Chart ↔ 3D

- **On click** sets what a bucket click does to the model: **Ghost others** (the default — the bucket's elements stay solid, everything else turns translucent), **Isolate** (hide everything else) or **Highlight** (selection outline only). The panel claims the isolate/ghost channel it writes and releases only what it installed, so an isolation another feature set up survives a chart click, and vice versa.
- A pick in the viewport highlights the matching bucket; a bucket that is only partly selected is emphasised, not marked selected. A foreign pick drops the dashboard slice.
- **Colour in 3D** pushes the first chart's bucket colours onto the model as an overlay layer (priority 75 — above the lens, below a running 4D playback). The chart that produced the selection keeps its full aggregation while the other cards cross-filter. Its selected elements retain the exact clicked bucket colour across overlap, reordering, and named ↔ **Other** folding; in **Ghost others** mode, unselected context keeps its authored model colours. Colours are assigned per label and kept when a bucket changes rank, so the legend stays a key.
- The **frame** button on a card frames the selected buckets (or the whole chart) in the camera.

## Coordination report (PDF)

**Report** in the panel header prints the active dashboard: choose A4 or A3, portrait or landscape, fill the title-block fields (seeded from the 2D sheet's title block when one exists — project, drawn by, revision — plus report title and date), and optionally include a **3D snapshot of each chart's largest bucket**, ghosting everything else. Every chart is drawn as a vector (ECharts → SVG → PDF), followed by its bucket table (label, element count, measure); a table longer than the page space is cut with an "… n more" row. Pages break between chart blocks and carry a running header, a footer with the generation time, and page numbers. A snapshot that cannot be captured (no WebGPU renderer, a lost canvas) is reported in its place; the rest of the report still renders. The page setup and fields are remembered on the dashboard, so the next export is one click — a dashboard exported to a file with a page setup is a **report template**.

## Dashboards

Cards sit on a 12-column grid: drag a card by its title bar, resize it from the corner; positions are part of the dashboard and saved with it. The **⋯** menu next to the dashboard picker renames, duplicates, deletes, exports the dashboard as an `.ifclite-dashboard.json` file, or imports one — an imported dashboard gets fresh ids so it never collides with the copy it came from, and its layout comes along.

Dashboards persist in the browser like saved lists. The first open seeds **Model overview** (elements by type, by storey, and types per storey); the dashboard picker's *New from preset* group adds **Coordination** (clashes by type pair, severity, review status per storey, penetration depth; topics by status, open topics by assignee and due, topics created and closed per week), **Delivery** (IDS result per specification, failures by facet and entity type, elements treemap) and **Schedule** (tasks by phase at the cursor and by type, tasks starting per week, products per phase). Add, edit and remove charts from the panel header; every dashboard is a `DashboardSpec` JSON document validated on load, so a hand-edited or stale entry is dropped with a warning rather than crashing the panel.
