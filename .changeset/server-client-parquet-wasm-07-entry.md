---
'@ifc-lite/server-client': major
---

`parquet-decoder.ts` imported `parquet-wasm/esm/arrow2.js`, an entry point parquet-wasm removed in 0.6, while `peerDependencies` advertised `parquet-wasm >=0.5.0`. In-repo that range auto-installed 0.5.0, where the path still existed, so nothing here failed; a consumer who installed 0.7 (what the rest of this workspace pins) got a missing module the first time any Parquet decode ran. The decoder now imports the package entry point `parquet-wasm` and lets its export map pick the build, the same shape `@ifc-lite/export` already uses, and the peer range narrows to `^0.7.2`, the version that entry point is verified against. A new test decodes a payload written by the resolved parquet-wasm, so the dropped entry point cannot come back unnoticed.

**Breaking:** this drops support for parquet-wasm 0.5 and 0.6. parquet-wasm 0.5 declares no `exports` and no `main`, so under Node the new bare `import('parquet-wasm')` fails outright with `ERR_MODULE_NOT_FOUND` (verified against 0.5.0). A consumer still on 0.5 whose Parquet decoding worked before gets a hard failure, not a peer-dependency warning: upgrade to `parquet-wasm@^0.7.2` alongside this release.
