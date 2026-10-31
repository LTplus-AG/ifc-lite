---
"@ifc-lite/viewer": patch
---

A model loading in a tab the browser froze (background-tab freezing, an efficiency or energy-saver mode, the machine sleeping) no longer fails with "Geometry stream stalled" the moment the tab resumes. The stall watchdog now counts only time the page was running: a timer that fires more than 5 s late re-arms a full window instead of failing. A pool that stays silent for a full window while the page runs still fails on time.

Every `geometry_stream_stalled` capture, including the first attempt that triggers the lower-detail retry, now carries `stall_phase` and `file_size_mb`; previously only the terminal capture did. Stall captures also report `was_hidden`, `hidden_at_stall`, `stall_late_ms` and `watchdog_suspended_rearms`.
