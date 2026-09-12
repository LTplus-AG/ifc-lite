---
"@ifc-lite/wasm": patch
---

`setEntityIndex`, `finalizePrepassStyles` and `buildPrePassStreamingSharded` now throw when their parallel column arguments disagree in length, instead of trapping the worker instance (`panic=abort`) or silently doing nothing. A rejected `setEntityIndex` also drops the previous file's index, content caches and pipeline diagnostics before it throws, so a worker reused across loads no longer resolves the next file's references through the previous file's byte offsets. Calling `setEntityIndex` with empty columns now clears the index, and the next batch scans its bytes.
