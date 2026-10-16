---
"@ifc-lite/wasm": patch
---

HBJSON and DFJSON exports keep survey precision for georeferenced models. A space's world position was rounded to f32 before the energy exporters rebased it, so at national-grid coordinates (LV95, about 2.6e6 m) two spaces authored 4.1 m apart came out 4.25 m apart and lost their adjacency. The position now stays in f64 until the rebase. The `extractProfiles` `transform` getter is unchanged and still returns a `Float32Array`.
