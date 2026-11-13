---
"@ifc-lite/viewer": patch
---

Post-load work (the scene snapshot write, the overlay parse, source compaction and the tier-1 search index) now also waits for the viewer's load window to close, so it starts only after the frame that shows the settled load has painted. Before, it could start when the model's record turned complete, which on a cache hit is before the UI settles. Only the model's own load holds its work: a model that had settled when another model's load began is not held back, and in a multi-file open each model's work starts once that model's own load has ended and its frame has painted. A load whose flag never clears is released by the load window's own limit.
