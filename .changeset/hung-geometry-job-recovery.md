---
"@ifc-lite/geometry": minor
"@ifc-lite/viewer": patch
---

A single element whose geometry never finishes no longer fails the whole load with "Geometry stream stalled". The parallel pool now notices a worker stuck inside one geometry call, replaces it, re-runs that call one element at a time, and skips only the element that still never finishes. The `complete` event reports skipped elements as `skippedHungElements` (express ids plus counts by IFC type). The new `hungJobTimeoutMs` option sets the silence budget; `0` disables recovery. The new `signal` option terminates the worker pool when a consumer abandons the stream, which `return()` alone could not do while the stream waited on a silent worker. The viewer tells the user which element types were left out and aborts the pool when it closes a stream.
