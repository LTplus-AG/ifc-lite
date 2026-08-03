---
'@ifc-lite/mcp': patch
'@ifc-lite/export': patch
'@ifc-lite/cli': patch
'create-ifc-lite': patch
---

Fixed the remaining `GeometryProcessor` WASM handle leaks tracked in issue #1959, beyond the viewer P0 sites fixed separately. Each site now frees its handle in a `try/finally` covering every early-return and throw path, not just the happy path:

- `@ifc-lite/mcp`: `clash_check` / `clash_matrix`'s model meshing (long-lived MCP server process, one handle per never-before-clashed model).
- `@ifc-lite/export`: `generateLod1`'s primary and fallback processors, including the forced-meshing-failure fallback path.
- `@ifc-lite/cli`: `diagnose-geometry`, `extract-entities --detect`, and `gym`'s lazily-created clash-channel processor — all reachable more than once per process from a long-lived host (a test harness, a REPL session) even though each is a one-shot CLI command in normal use.
- `create-ifc-lite`: the generated React + WebGPU template's mount effect now disposes its `GeometryProcessor` on both the mid-init cancellation path and on unmount, so scaffolded projects don't inherit the leak.

`apps/viewer/src/hooks/useIfcLoader.ts` is intentionally untouched: its processor's WASM handle is shared with `IfcParser.parseColumnar` via `getApi()`, and disposal there needs a design decision (owned-and-reused vs. freed-per-call) that has not been made yet.
