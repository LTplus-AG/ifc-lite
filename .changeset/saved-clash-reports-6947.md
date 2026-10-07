---
"@ifc-lite/charts": minor
"@ifc-lite/viewer": minor
---

Save a clash result as a named report and choose, per chart, between the current result and one saved report. Open **Saved clash reports** in the Clash panel header to save, rename or delete reports; in the chart editor a clash chart picks **Current result** or a report under **Clash report**. A chart bound to a report keeps its results when another check runs, so two charts can show two runs side by side. Reports are kept in the browser's saved content library, survive a reload, and are part of the library backup and its import. A chart of a saved report says when the run was partial, when the model changed before it was saved, and when the loaded model is another revision; its rows never select or frame elements of the loaded model. A chart whose report was deleted shows **Saved clash report unavailable** and offers **Choose a source**, and never shows the current result in its place. Existing clash charts are unchanged and keep reading the current result.

`ChartSpec.clashReportId` is the new optional binding. Validation rejects an empty ID, a binding on a source other than `clash`, and an element filter beside it.
