---
"@ifc-lite/geometry": patch
---

Bound how long one worker owns a heavily repeated geometry key. After a run of 4,096 jobs, route the key to the worker with the fewest assigned affinity jobs; retain sticky routing and round-robin assignment for smaller keys. This prevents one repeated geometry from pinning almost an entire model to one worker.
