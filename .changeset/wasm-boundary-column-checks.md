---
"@ifc-lite/wasm": major
"@ifc-lite/geometry": major
---

`setEntityIndex`, `finalizePrepassStyles` and `buildPrePassStreamingSharded` now throw when their parallel column arguments disagree in length, instead of trapping the worker instance (`panic=abort`) or silently doing nothing. A rejected `setEntityIndex` also drops the previous file's index, content caches and pipeline diagnostics before it throws, so a worker reused across loads no longer resolves the next file's references through the previous file's byte offsets. Calling `setEntityIndex` with empty columns now clears the index, and the next batch scans its bytes. The geometry worker no longer replays a rejected entity index when it re-initialises its IfcAPI.

**Migration:** callers must be ready for `setEntityIndex`, `finalizePrepassStyles` and `buildPrePassStreamingSharded` to throw on columns of unequal length (`finalizePrepassStyles` needs exactly four colour floats per id). A caller that used `setEntityIndex` with empty columns as a no-op that kept the current index must stop doing so: it now clears the index.
