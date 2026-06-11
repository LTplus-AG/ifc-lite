---
"@ifc-lite/wasm": minor
"@ifc-lite/geometry": minor
---

One CSG kernel: pure-Rust exact mesh arrangement. The Manifold C++ kernel
(viewer/WASM) and the legacy in-tree BSP port (server/native) are replaced by a
single clean-room exact-arithmetic kernel (Cherchi-style indirect predicates)
that runs identically on native and wasm32 — bit-deterministic across x86_64,
aarch64 and the browser, with no C++ toolchain in the build.

No API changes — `processGeometryBatch` and the SDK surface are unchanged.
Consumers see different (better) triangulations wherever booleans fire:
openings, clippings and flush recesses now cut watertight through exactly
coincident/coplanar faces instead of relying on perturbation epsilons, tilted
flush cuts no longer leave boundary cracks or seam slivers, and deep
clipping-chain cutters are unioned and subtracted in one arrangement. Geometry
fingerprints (`geomHash`) for boolean-cut elements change accordingly; the
compare-models flow is unaffected because both revisions hash in-session with
the same kernel.
