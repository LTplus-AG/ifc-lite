---
"@ifc-lite/wasm": minor
"@ifc-lite/geometry": minor
"@ifc-lite/export": minor
"@ifc-lite/cli": patch
"@ifc-lite/mcp": patch
---

Make the Rust-backed exporters reliable on large and degenerate inputs.

Remove the ~512 MB input cap on GLB/glTF (and the sibling OBJ, CSV, JSON, JSON-LD,
STEP, IFCX, HBJSON exporters). They decoded the entire input IFC byte buffer into a
single JS string via `safeUtf8Decode` before crossing into WASM, where the binding
immediately turned it back into bytes (`content.as_bytes()`). For an input over V8's
`0x1fffffe8` (~512 MB) string ceiling that decode threw "Cannot create a string longer
than 0x1fffffe8 characters", so files in the 0.5 GB+ range failed before any geometry
ran. The boundary now passes the raw `Uint8Array`/`&[u8]` straight through (matching the
existing `exportMerged` path), which removes the cap, drops a redundant full-buffer copy
and a UTF-8 re-encode, and is byte-faithful for non-UTF-8 input.

Scope: this lifts the cap on the INPUT side for all exporters. GLB returns a
`Uint8Array`, so its output also escapes the V8 ceiling; the string-returning
exporters (OBJ/CSV/JSON/JSON-LD/STEP/IFCX/HBJSON) still cap their serialized OUTPUT
at the same ~512 MB string limit. In-browser, the wasm32 linear-memory heap (not the
string cap) is the practical ceiling for the very largest models.

Fail loud on an empty GLB export. A malformed-but-parseable model (or a filter whose
matched entities carry no triangulated geometry) produced a structurally valid GLB with
zero meshes, which the CLI and MCP tools wrote to disk and reported as success. Both now
reject a zero-mesh GLB with a clear error (new `countGlbMeshes` helper in
`@ifc-lite/export`).

Guard the GLB assembler against the glTF 32-bit buffer limit. The assembler cast every
buffer offset and byteLength `as u32`; past 4 GiB those casts silently wrapped (release
builds disable overflow checks) and emitted a corrupt GLB. It now sums the binary buffer
length in `usize` and asserts the 4 GiB ceiling with a clear message instead of wrapping.
