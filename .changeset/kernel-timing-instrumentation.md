---
"@ifc-lite/geometry": patch
---

Add opt-in, feature-gated CSG kernel timing instrumentation (`kernel-timing`).

Behind the off-by-default `kernel-timing` cargo feature: per-phase wall-clock,
per-phase op counts, and predicate-tier escalation counts on both native and
WASM, to profile where boolean CSG time goes. Default builds compile it out
entirely — no shipped-artifact or runtime change.
