---
"@ifc-lite/viewer": patch
---

Post-load work (the scene snapshot write, the overlay parse, source compaction and the tier-1 search index) now also waits for the viewer's load window to close, so it starts only after the frame that shows the settled load has painted. Before, it could start when the model's record turned complete, which on a cache hit is before the UI settles. The window is global, so another model's load also holds this work back.
