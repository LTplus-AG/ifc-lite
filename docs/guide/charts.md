# Charts

The **Charts** panel turns the loaded models into a dashboard of charts that stay bound to the 3D view: click a bar or a slice and its elements are selected in the model; pick an element in the model and the chart lights up the bucket it belongs to; the selection in one chart slices every other chart on the dashboard. It lives in the bottom strip next to Lists and Schedule (**Analyze → Charts**, or `Charts` in the command palette).

## What a chart is

A chart is a **dataset** plus a **spec**. The dataset has one row per thing being counted — an element, a clash pair, a topic — and every row carries the ids of the elements it stands for. The spec says how to bucket the rows:

| Field | Meaning |
|-------|---------|
| Chart | `bar`, `stackedBar`, `pie`, `treemap`, `histogram` (bins a number column), `timeline` (buckets a date column into ISO weeks) |
| Group by | The column whose distinct values become the buckets |
| Stack by | For a stacked bar: a second category column, one series per value |
| Measure | `count` of rows, or the `sum` of a number column |
| Top N | Keep the N largest buckets and fold the rest into one grey **Other** bucket (which still carries every element it stands for) |
| Order | Largest first, or by label (dates and histogram bins are always chronological / ascending) |

Because a bucket keeps its element ids, the bidirectional link needs no support from the chart library: a click is `bucket → ids`, a 3D pick is `ids → buckets`. The headless half is the [`@ifc-lite/charts`](https://github.com/LTplus-AG/ifc-lite/tree/main/packages/charts) package, which the CLI and the PDF export share.

## Sources and scope

| Source | One row per | Columns | A bucket selects |
|--------|-------------|---------|------------------|
| **Elements** | element instance across every loaded model | `IFC type`, `Storey`, `Model`, `Name` — straight off the entity tables, no list needs to run | the elements |
| **Clash results** | clash of the current run (after exclusions) | `Rule`, `Severity`, `Detection` (hard / clearance / touch), `Review status`, `Type A`, `Type B`, `Type pair`, `Model A`, `Model B`, `Storey`, `Distance` (m, for a penetration histogram), `Group` | both elements of every clash in it |
| **BCF topics** | topic of the loaded project | `Status`, `Type`, `Priority`, `Assigned to`, `Stage`, `Labels`, `Author`, `Due` (overdue / this week / later / none), `Age` (days), and the dates `Created`, `Modified`, `Due date`, `Closed` | the components of the topics' viewpoints that are loaded |
| **Schedule tasks** | task of the active schedule | `Task`, `Status`, `Phase at cursor` (not started / in progress / done, following the 4D playback), `Task type`, `Critical`, `Milestone`, `Duration` (days), `Products`, and the dates `Start`, `Finish` | the tasks' products |
| **IDS results** | (specification, entity) result of the last validation | `Specification`, `Result` (pass / fail), `Entity type`, `Failing facet`, `Model` | the entities |
| **Model compare** | diff entry of the last comparison | `State`, `What changed`, `IFC type`, `Revision` | the head-side entity (base-side for a deletion) |

Date columns feed the `timeline` chart, which buckets per ISO week — topics created or closed per week, tasks starting per week. There is no run history in the viewer, so BCF dates are the only time axis; clash counts over successive runs are not charted.

The dashboard's **scope** applies to the elements source and decides which elements its rows cover: all loaded models, only what is visible right now (the same answer the Lists panel's "visible only" gives), or the basket.

## Chart ↔ 3D

- **On click** sets what a bucket click does to the model: **Ghost others** (the default — the bucket's elements stay solid, everything else turns translucent), **Isolate** (hide everything else) or **Highlight** (selection outline only). The panel claims the isolate/ghost channel it writes and releases only what it installed, so an isolation another feature set up survives a chart click, and vice versa.
- A pick in the viewport highlights the matching bucket; a bucket that is only partly selected is emphasised, not marked selected. A foreign pick drops the dashboard slice.
- **Colour in 3D** pushes the first chart's bucket colours onto the model as an overlay layer (priority 75 — above the lens, below a running 4D playback). Colours are assigned per label and kept when a bucket changes rank, so the legend stays a key.
- The **frame** button on a card frames the selected buckets (or the whole chart) in the camera.

## Dashboards

Cards sit on a 12-column grid: drag a card by its title bar, resize it from the corner; positions are part of the dashboard and saved with it. The **⋯** menu next to the dashboard picker renames, duplicates, deletes, exports the dashboard as an `.ifclite-dashboard.json` file, or imports one — an imported dashboard gets fresh ids so it never collides with the copy it came from, and its layout comes along.

Dashboards persist in the browser like saved lists. The first open seeds **Model overview** (elements by type, by storey, and types per storey); the dashboard picker's *New from preset* group adds **Coordination** (clashes by type pair, severity, review status per storey, penetration depth; topics by status, open topics by assignee and due, topics created and closed per week), **Delivery** (IDS result per specification, failures by facet and entity type, elements treemap) and **Schedule** (tasks by phase at the cursor and by type, tasks starting per week, products per phase). Add, edit and remove charts from the panel header; every dashboard is a `DashboardSpec` JSON document validated on load, so a hand-edited or stale entry is dropped with a warning rather than crashing the panel.
