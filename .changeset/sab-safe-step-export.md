---
"@ifc-lite/export": patch
---

Fix STEP/IFC export failing with `TextDecoder.decode: ArrayBufferView ... can't
be a SharedArrayBuffer` when the data store's source buffer is SAB-backed.
Both `StepExporter` and `MergedExporter` now route all source-byte decodes
through `safeUtf8Decode` from `@ifc-lite/data`, which transparently copies
into a scratch buffer on the (Firefox / Chrome-with-mitigation) runtimes
that reject `TextDecoder.decode()` on `SharedArrayBuffer` views.
