---
"@ifc-lite/viewer": patch
---

Work no load waits for (the scene snapshot write, the overlay parse, source compaction, the tier-1 search index) runs from one schedule: after its model's load settles, in an idle period, in that order, and dropped if the model is removed or reloaded first. Source compaction no longer copies the source into a worker in the task that settles the load, nor for a model removed before it started.
