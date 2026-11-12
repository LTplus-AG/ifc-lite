---
"@ifc-lite/viewer": patch
---

Post-load work (the scene snapshot write, the overlay parse, source compaction and the tier-1 search index) now also waits for the viewer's load window to close, so it starts only after the frame that shows the settled load has painted. Before, it could start when the model's record turned complete, which on a cache hit is before the UI settles. Only the model's own load holds its work: a model that had settled when another model's load began is not held back. The hold on a settled model is capped at 3 s, so a multi-file open or a load that never settles does not delay an earlier model's source compaction or search index until the last file.
