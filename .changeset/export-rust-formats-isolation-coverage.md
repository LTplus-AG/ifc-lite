---
"@ifc-lite/cli": patch
---

Add direct test coverage for `packages/cli/src/commands/export-rust-formats.ts` (`exportRustFormat`), which previously had none — no file imported it. Mirroring the MCP pattern from #4364/#4386, the new tests mock `GeometryProcessor` and assert on the actual `isolated` argument passed to `gp.exportGlb`/`gp.exportObj` (not just the return value): `undefined` when no `--type` filter is requested, a real `Uint32Array` of matched expressIds when one matches, and a rejection before the exporter is ever called when a filter matches nothing. A mocked test that only checks the return value would not have caught the #4364/#4386 regression, where this file briefly passed an explicit empty `Uint32Array` to mean "no filter" under the new wasm-boundary convention (which reads that as "isolation active, matches nothing") and made every plain `ifc-lite export --format glb`/`obj` fail with a misleading "0 meshes" error.
