---
"@ifc-lite/geometry": patch
---

Emit a meaningful message when a geometry worker crashes. A hard worker crash
(e.g. the wasm thread aborting under memory pressure) fires an `ErrorEvent`
with an empty `message`, so the pool reported the cryptic, unclassifiable
"Geometry worker failed: undefined". It now synthesises a message from
whatever the `ErrorEvent` carries (`filename:lineno`, or
"worker terminated unexpectedly"), so the failure is human-readable and the
viewer's load-error classifier can bucket it instead of filing it as a raw
one-off error.
