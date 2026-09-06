---
"@ifc-lite/cache": minor
---

Allow browser callers to move geometry cache compression into one bounded worker while preserving cache format and the workerless default. Transfer serialized chunks without cloning model data and terminate the worker on success or failure.
