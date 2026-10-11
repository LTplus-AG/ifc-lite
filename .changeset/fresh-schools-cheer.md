---
"@ifc-lite/parser": minor
---

Resolve occurrence quantity Units and their dependencies against an optional current native mutation view, so edits, replacement, deletion and Undo no longer retain stale source physical metadata (#7379).

Throw `OccurrenceQuantityReadError` when the current quantity inventory is unreadable or exceeds its bounds, so consumers can distinguish unavailable coverage from verified absence.
