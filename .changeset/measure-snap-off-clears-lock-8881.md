---
"@ifc-lite/viewer": patch
---

Measure: turning Snap off now drops the hover edge lock and the snap glyph (#8881). Hover stops while Snap is off, so the stale lock used to pull the next first click or tap along the old edge, and the glyph stayed on screen. A pending Distance start is kept. Turning Snap back on locks and snaps as before.
