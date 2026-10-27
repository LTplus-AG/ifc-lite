---
"@ifc-lite/wasm": minor
---

Rust only, in `ifc-lite-processing` and `ifc-lite-geometry`. Symbolic extraction (2D plan, annotation, footprint and axis symbols) now resolves each product's placement through the shared iterative placement walk and composes the full 3D product, context, mapping and conic frames before projecting to the plan. Symbols on products whose placement is tilted or points down the negative Z axis, such as curved beam axes, now land where the 3D model puts them instead of being flattened into a plan rotation. Elevations and text baselines follow the composed frame. Products with a malformed placement are dropped and counted; a dangling, wrong-type or cyclic placement keeps the existing unresolved-origin behaviour. `PlacementError::is_admission_refusal` is new and tells those two cases apart. Product and representation labels are no longer copied for products without symbols.
