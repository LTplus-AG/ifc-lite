---
"@ifc-lite/wasm": patch
---

Carry `IfcAnnotationFillArea` hatching style across the WASM boundary instead of dropping it.

`SymbolicRepresentationCollection::from_data` builds each fill with `SymbolicFillArea::new`, which defaults to unhatched, and never applied the style — so `has_hatching`, `hatch_spacing`, `hatch_angle`, `hatch_angle_secondary` and `hatch_line_width` were reset on every fill on the way to the browser. Both ends of that wire already handle hatching: the canonical `ifc_lite_processing::SymbolicFillArea` carries all five fields and round-trips them through the JSON path (including the NaN-as-`null` sentinel for an absent cross-hatch angle), and the viewer reads all five straight off this object in `apps/viewer/src/lib/overlay-parse/symbolic-flat.ts`. Only the converter in between forgot them, which contradicts its own doc comment's promise that the browser and the HTTP server produce identical symbol streams. `with_hatching`, the builder written for exactly this, had no caller anywhere in the tree.

No rendering changes today: the extractor (`rust/processing/src/symbolic/fill.rs`) currently emits `has_hatching: false` unconditionally, so the drop was latent — it would have surfaced as "hatching works on the server, renders solid in the browser" the moment `IfcFillAreaStyleHatching` resolution was wired up on the extractor side. The absent secondary angle is routed back through `Option` rather than passed on as a bare NaN, so `0.0` (a real cross-hatch at 0 rad) stays distinguishable from "no cross-hatch".

`from_data` moves to a sibling `symbolic_from_data.rs` alongside a new `symbolic_tests.rs` covering the whole conversion field by field — it is the one part of that file with a failure story of its own, and nothing but a test can see a hand-written transcription between two parallel struct families transpose a pair or leave a field behind.
