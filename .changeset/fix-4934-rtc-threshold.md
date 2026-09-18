---
"@ifc-lite/wasm": patch
---

Lowered the Rust `LARGE_COORD_THRESHOLD_METERS` gate (the single home every crate reads to decide whether a model needs an RTC re-base before its geometry is cast to f32) from 10 km to 1 km. A model whose coordinates sit in the 1-10 km band — a common survey-grid site layout — previously got no RTC shift and had its vertices quantized to a ~0.26-0.5 mm f32 lattice, visible as z-fighting speckle at flush joins (#4934). Models already past 10 km are unaffected; models in the 1-10 km band get a new RTC anchor and, as a one-time consequence, a new `placementFrameKey` on first load after upgrading.

The viewer's `apps/viewer/src/hooks/geometryCacheKey.ts` `GEOMETRY_OUTPUT_REVISION` was bumped alongside this (2, was 1) so a 1-10 km model already cached under the old gate is a cache miss and re-tessellates with the corrected pre-pass output on the next load, rather than serving the old un-rebased meshes indefinitely.
