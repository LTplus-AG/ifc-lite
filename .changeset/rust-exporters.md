---
"@ifc-lite/geometry": minor
"@ifc-lite/wasm": minor
---

Add Rust-backed domain-format exporters. The new `ifc-lite-export` crate is the
source of truth for HBJSON, Wavefront OBJ, glTF/GLB, CSV, JSON and JSON-LD (plus a
native-only ara3d BOS/Parquet path). They are exposed via wasm
(`exportHbjson`/`exportObj`/`exportGlb`/`exportCsv`/`exportJson`/`exportJsonld`) and
reachable from TypeScript through `GeometryProcessor.export*` and
`IfcLiteBridge.export*`. Geometry exporters fold per-mesh RTC origin correctly (glTF
emits it as a node translation, keeping f32 vertex precision at georef scale).
