---
'@ifc-lite/server-client': minor
---

`parquet-decoder.ts` imported `parquet-wasm/esm/arrow2.js`, an entry point parquet-wasm removed in 0.6, while `peerDependencies` advertised `parquet-wasm >=0.5.0`. In-repo that range auto-installed 0.5.0, where the path still existed, so nothing here failed; a consumer who installed 0.7 (what the rest of this workspace pins) got a missing module the first time any Parquet decode ran. The decoder now imports the package entry point `parquet-wasm` and lets its export map pick the build, the same shape `@ifc-lite/export` already uses, and the peer range is narrowed to `^0.7.0`, the version range that entry point is verified against. A new test decodes a payload written by the resolved parquet-wasm, so the dropped entry point cannot come back unnoticed.

Minor rather than patch: narrowing the peer range means an installation pinned to parquet-wasm 0.5 or 0.6 that resolved cleanly before will now report an unmet peer dependency.
