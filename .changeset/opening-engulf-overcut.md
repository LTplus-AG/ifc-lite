---
"@ifc-lite/wasm": patch
---

Geometry: a rotated/engulfing opening no longer over-cuts its host wall (#947, advanced_model #555433, which collapsed to a ~1.5%-volume sliver). When a non-rectangular opening's bounding box engulfs the wall but its real profile excludes it, the kernel returns the un-cut host — which is correct — so the void router now keeps that result instead of falling back to a rectangular AABB cut that would delete the wall. High-poly openings rejected by the BSP operand cap (issue-635) still receive the AABB box, so genuinely-complex voids are not left uncut.
