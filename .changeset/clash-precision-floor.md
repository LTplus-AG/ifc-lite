---
'@ifc-lite/clash': patch
---

Stop reporting float32-precision noise as hard clashes.

The narrow phase classified any genuine (non-coplanar) triangle-mesh crossing as `hard`, regardless of how tiny the measured penetration depth was — including depths that are literally float32 rounding noise. Geometry is ingested from f32 buffers and stored/queried in f64 (`rust/clash/src/tri_mesh.rs`), so f64 arithmetic cannot recover precision the source data never had: two surfaces authored to be flush round to adjacent f32 values, and the tiny "penetration" between them is bit-noise, not a measurement.

On buildingSMART's `Infra-Bridge.ifc` sample, this reported 31 spurious hard clashes at CLI defaults (of 81 total): 20 were bit-identical at `-2.384185791015625e-7` m — exactly the float32 ULP at coordinate magnitude `[2,4)` — across unrelated element-type pairs (`IfcColumn`×`IfcWall`, `IfcColumn`×`IfcMember`, `IfcColumn`×`IfcBuildingElementProxy`) at different physical locations on the model; the rest sat in the same `1e-8`–`2e-6` m noise band. These are joints designed to be flush (a pier meeting a spandrel wall, a deck resting on a girder), not coordination issues.

The fix adds a penetration-depth floor scaled to the pair's own coordinate magnitude — `max(1.0, maxAbsCoord) * 2^-22`, the same `extent · 2⁻²²` term `near_band_from_extent` uses in `rust/geometry/src/kernel/mesh_bridge.rs` — rather than a fixed constant, since the float32 ULP at a coordinate near the origin is not the ULP at a coordinate far from it, and infrastructure models routinely sit far from the origin. A crossing at or below the floor is reclassified as `touch`, not `hard`: the surfaces genuinely are in contact, which is real information this codebase already tracks separately (the viewer's `clashHideTouching` toggle), so it is not silently dropped. CLI-default rules don't opt into `reportTouch`, so these pairs report zero clashes rather than a spurious hard one.

Measured on `Infra-Bridge.ifc`: 81 → 50 hard clashes at CLI defaults (TS and WASM/Rust backends agree). The 8 real `IfcBeam`×`IfcBeam` coordination-issue pairs are unaffected. Three existing building-model test suites (193 clash-package tests, including the differential TS/WASM parity suite) show no count changes — the floor is far below any real construction-tolerance overlap on those fixtures.

No API surface change.
