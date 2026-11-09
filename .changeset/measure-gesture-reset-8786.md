---
"@ifc-lite/viewer": patch
---

Measure: every gesture reset now clears the edge lock and the snap glyph and drops the queued rubber-band frame (#8786). This covers Esc, a mode or angle-kind switch, Clear all, entering or leaving the tool, and a model reposition. A press that began before a reset no longer places a point when it is released. For example, a Distance press held while switching to Polyline used to add a Polyline point the user never placed. This holds for both mouse and touch.
