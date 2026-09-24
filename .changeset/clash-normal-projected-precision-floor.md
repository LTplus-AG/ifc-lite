---
"@ifc-lite/clash": patch
"@ifc-lite/wasm": patch
---

The Hard/Touch threshold for clash depths no longer depends on where the model sits in world space.

A penetration depth at or below the f32 noise of the coordinates it was measured from is reported as a touch, not a hard clash. That floor used to be the largest absolute coordinate of the pair over all three axes times 2^-22, so a model 10 km out along X handed a vertical (Z-direction) contact about 2.4 mm of slack derived entirely from the irrelevant X magnitude. A genuine 2 mm overlap was a hard clash at the origin and a touch 10 km away, and near the origin the largest coordinate on any axis still set the threshold for contacts that have no component along it.

Each depth candidate (the box-to-box penetration, the AABB estimate, and the crossing-vertex evidence for contained pairs) now carries the direction it was measured along, and is tested against the pair's per-axis noise projected onto that direction. The per-axis noise has two terms, both scaled by 2^-22: the axis's own coordinate magnitude (`max(1, |c|)`, the same rule as the triangle contact band), and the two elements' own sizes (each AABB's largest extent, summed), since placement and tessellation rounding grows with the element's size on every axis. The size term does not change under translation. The rule is defined once in the shared clash-math source, so the TypeScript and Rust kernels use the same floor.

Measured on eight sample models: no pair becomes a new hard clash at the models' own placement, 15 hard clashes of 1.9 to 6 micrometres become touches, and the verdicts that change when the whole model is moved 1 km or 10 km along X drop on three of the models (none increase).
