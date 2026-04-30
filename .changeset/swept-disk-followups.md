---
"@ifc-lite/wasm": patch
---

Two follow-ups to the `IfcSweptDiskSolid` trim-param fix from #606, plus the rebuilt WASM artifact that actually lands the trim-param logic at runtime (CI does not rebuild the WASM binary; consumers were still on the pre-#606 binary).

- **Junction-point dedup is now coordinate-aware.** When concatenating trimmed composite-curve segments, the previous implementation unconditionally dropped the first point of each subsequent segment — fine when adjacent segments share a coordinate-identical junction vertex, but it silently distorted directrices whose adjacent segments meet at non-coincident endpoints (model drift, mismatched cartesian points). The first point is now dropped only when it coincides with the last point already collected (`< 1e-6`), preserving the gap otherwise.

- **Cross-section frame no longer flips at sharp bends.** `SweptDiskSolidProcessor` was re-picking the perpendicular `up` vector at every cross-section based on `tangent.x.abs() < 0.9`; consecutive tangents that straddled the threshold flipped the sign of `perp1`, so the same vertex index pointed to opposite angular positions on consecutive rings — visible as a twisted / flat-ribbon tube at L-bends and rebar hooks. Replaced with a Rotation-Minimising Frame: `up` is chosen once for the first sample, and each subsequent frame is propagated by the minimum rotation that aligns the previous tangent onto the current tangent (Rodrigues). Adds three unit tests covering straight-line invariance, 90° L-bend non-flip, and degenerate-input handling.
