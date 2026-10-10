---
"@ifc-lite/wasm": patch
---

Preserve host corners when opening cutters coincide with existing profile holes. Analytic prism cuts and exact-kernel cuts now share reconciliation of a cutter corner one internal grid step from its host corner. The subtract weld also preserves a cutter vertex that already lies exactly on a host face instead of moving it onto a nearby face. In the MiniBIM reference model, the eight previously closed affected slabs remain closed after their opening cuts in the viewer and native pipeline. The ninth affected slab has pre-existing tears that remain unresolved; this change does not repair arbitrary input topology.
