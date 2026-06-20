---
"@ifc-lite/geometry": minor
"@ifc-lite/wasm": minor
"@ifc-lite/cli": minor
---

Add Rust-backed domain-format exporters. The new `ifc-lite-export` crate is the
source of truth for HBJSON, Wavefront OBJ, glTF/GLB, CSV, JSON and JSON-LD (plus a
native-only ara3d BOS/Parquet path). They are exposed via wasm
(`exportHbjson`/`exportObj`/`exportGlb`/`exportCsv`/`exportJson`/`exportJsonld`) and
reachable from TypeScript through `GeometryProcessor.export*` and
`IfcLiteBridge.export*`. Geometry exporters fold per-mesh RTC origin correctly (glTF
emits it as a node translation, keeping f32 vertex precision at georef scale).

The CLI `export` command gains `--format obj|gltf|glb|jsonld` (Rust-backed; `--type`/
`--storey`/`--where`/`--limit` act as the isolation set for OBJ/glTF).

Also makes the wasm geometry engine usable under Node: `IfcLiteBridge.init()` now reads
the `.wasm` bytes itself when running in Node (whose `fetch()` cannot load `file://`),
strictly Node-gated so the browser/worker path is unchanged. This additionally fixes
headless `clash`/geometry commands that previously failed to initialize wasm in Node.
