---
"@ifc-lite/charts": patch
"@ifc-lite/viewer": patch
---

Long category labels on bar-style charts are no longer cut off (#6480). The chart tab and the document page share one label layout that measures the labels, tilts them just enough to keep neighbours apart, gives them room at the bottom of the chart, and only then shortens them from the middle. Hovering a label shows its full name.
