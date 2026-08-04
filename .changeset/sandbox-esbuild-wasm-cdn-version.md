---
"@ifc-lite/sandbox": patch
---

Derive the `esbuild.wasm` CDN fallback URL from the loaded `esbuild-wasm` host version instead of a hard-coded one.

`transpile.ts` asked unpkg for `esbuild-wasm@0.27.3/esbuild.wasm` under a comment claiming it was "version-pinned to match installed package", while the package depended on `^0.28.1` and resolved 0.28.1. `esbuild.initialize()` rejects a host/binary version mismatch outright ("Host version does not match binary version"), so that fallback could not start: every embedder reaching it dropped to the regex transpiler instead of esbuild. A hard-coded literal and a `^` range cannot stay in step by construction, so the URL now interpolates `esbuild.version` from the module that was just imported — the same host whose version `initialize()` checks — and there is nothing left to keep in sync. The dependency range is unchanged.

The CDN branch is only reached under bundlers that do not implement Vite's `?url` asset hint; the first-party viewer builds with Vite and takes the bundled-asset path, so it was never affected.

Covered by `transpile-wasm-url.test.ts`, which mocks `esbuild-wasm` with a fabricated version and asserts the URL follows it, so a re-introduced literal fails CI.
