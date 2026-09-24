---
"@ifc-lite/export": patch
---

`MergedExporter` with `dropEmptyContainers` now also drops a container that is emptied by the one-parent pass. When a later model's Building unified with one the primary model already parents, that model's `Site -> Building` aggregation is not written, which leaves its Site with nothing in it. The drop planner still counted the Building as that Site's child, so the empty Site was written anyway. The planner now runs the same claim pass first and counts only the aggregation edges that will be written (#5725).
