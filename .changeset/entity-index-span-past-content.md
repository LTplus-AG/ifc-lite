---
"@ifc-lite/wasm": patch
---

An entity index installed with `setEntityIndex` whose byte span runs past the source content no longer aborts the worker instance. The raw-bytes and polyloop fast paths now treat such a span as a missing record, and a full decode of it reports an invalid byte span, as other out-of-range spans already did.
