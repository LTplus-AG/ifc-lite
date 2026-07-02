---
"@ifc-lite/wasm": major
"@ifc-lite/geometry": major
"@ifc-lite/cli": minor
"@ifc-lite/mcp": minor
---

feat(export): large-model GLB reliability - bounded memory, fail-closed, byte returns

Three related hardening changes on the export surface:

- **Bounded-memory GLB.** Inputs at or above 64 MB (native override
  `IFC_LITE_GLB_STREAM_THRESHOLD_MB`, `0` disables) are exported through a
  two-pass streaming assembler: pass 1 records per-mesh metadata only, pass 2
  re-streams and bakes vertex bytes directly into an exactly-preallocated GLB.
  Peak memory is the final artifact plus one mesh batch instead of the whole
  model's meshes plus multiple full-buffer copies - this fixes the wasm
  `RuntimeError: unreachable` / OOM on large in-browser exports. Models without
  instanceable groups produce byte-identical output; instanced models keep
  identical world geometry (rep-identity instancing is skipped above the
  threshold, content-hash dedup is kept).

- **Fail-closed empty GLB at the boundary.** `exportGlb` now throws a typed
  `Error` whose message starts with `NO_RENDER_GEOMETRY` when the visible mesh
  set is empty, instead of returning a structurally valid but empty GLB.
  `@ifc-lite/geometry` exports `NO_RENDER_GEOMETRY` and
  `isNoRenderGeometryError(err)` to match it; the CLI and MCP map it to their
  existing tailored messages.

- **BREAKING: sibling exporters return bytes.** `exportObj`, `exportCsv`,
  `exportJson`, `exportJsonld`, `exportIfcx`, `exportStep`, `exportMerged` and
  `exportHbjson` (wasm boundary, `IfcLiteBridge`, and `GeometryProcessor`) now
  return `Uint8Array` (UTF-8) instead of `string`, so output is no longer capped
  by the V8 max-string ceiling (~512 MB) - the same escape GLB already had.
  Decode with `TextDecoder` where a string is genuinely needed; file writers
  should write the bytes directly.
