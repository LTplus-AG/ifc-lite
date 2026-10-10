---
"@ifc-lite/parser": patch
---

Preserve unresolved explicit native quantity units and prevent project-unit fallback from publishing an unknown physical magnitude. Viewer declared-volume bases now honor canonical per-quantity units across Properties and zone tables.

Zone writeback now refuses physical quantity output when the current project target volume unit is unavailable, while retaining readable explicit-unit totals and safe zone labels.
