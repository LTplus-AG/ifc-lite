---
"@ifc-lite/geometry": minor
"@ifc-lite/wasm": minor
"@ifc-lite/cli": minor
"@ifc-lite/mcp": minor
"@ifc-lite/viewer": minor
"@ifc-lite/export": major
---

Add Rust-backed domain-format exporters. The new `ifc-lite-export` crate is the
source of truth for Wavefront OBJ, glTF/GLB, CSV, JSON and JSON-LD (plus a
native-only ara3d BOS/Parquet path). They are exposed via wasm
(`exportObj`/`exportGlb`/`exportCsv`/`exportJson`/`exportJsonld`) and
reachable from TypeScript through `GeometryProcessor.export*` and
`IfcLiteBridge.export*`. Geometry exporters fold per-mesh RTC origin correctly (glTF
emits it as a node translation, keeping f32 vertex precision at georef scale).

STEP export also supports schema conversion (`IFC2X3`/`IFC4`/`IFC4X3`/`IFC5` entity-type
renames + attribute trimming) and a mutation bridge — `exportStep` takes a `mutations_json`
payload (`MutablePropertyView` attribute edits + property-set synthesis: new
`IfcPropertySingleValue`/`IfcPropertySet`/`IfcRelDefinesByProperties` entities). New Rust exporters:
**IFC5/IFCX** (`exportIfcx` — USD-style node graph: spatial hierarchy + classes + known
IFC5 properties) and **Merged** (`exportMerged` — combine several models into one STEP,
id-offset + project unification).

The CLI `export` command gains `--format obj|gltf|glb|jsonld|step|ifcx` (Rust-backed;
`--type`/`--storey`/`--where`/`--limit` act as the isolation set — for `step` the forward
`#`-reference closure is added so a filtered export never dangles a reference; `--schema`
converts entity types). The MCP `export_glb` tool is unstubbed, `export_ifcx` is unstubbed,
and a new `export_obj` tool is added (all honour an optional `type` filter).

Also makes the wasm geometry engine usable under Node: `IfcLiteBridge.init()` now reads
the `.wasm` bytes itself when running in Node (whose `fetch()` cannot load `file://`),
strictly Node-gated so the browser/worker path is unchanged. This additionally fixes
headless `clash`/geometry commands that previously failed to initialize wasm in Node.

The viewer's GLB export now assembles the binary in Rust over the meshes it already
holds (`GeometryProcessor.exportGlbFromMeshes`, wasm `exportGlbFromMeshes`) instead of the
TypeScript GLTFExporter — no re-meshing, and the per-element RTC origin rides a glTF node
translation so georef-scale models keep vertex precision.

**BREAKING (`@ifc-lite/export`):** `GLTFExporter`, `JSONLDExporter`, and `CSVExporter`
(+ their option types) are removed — glTF/GLB, JSON-LD, and CSV are now produced in Rust. Use
`GeometryProcessor.exportGlb` / `exportGlbFromMeshes`, `exportJsonld`, and
`exportCsv(bytes, mode, …)` (mode ∈ `entities`|`properties`|`quantities`|`spatial`). All in-repo
callers (viewer GLB / command-palette / mobile / location-map / main-toolbar CSV exports, LOD1
generator) are migrated; the Rust CSV gained the spatial-hierarchy mode to match.
