---
'@ifc-lite/geometry': minor
'@ifc-lite/viewer': patch
---

The viewer's PostHog noise gate for auto-recovered wasm version skew (#1363) only matched the wasm-binary MIME/404 message text, so a worker-SCRIPT skew (classified separately, by `kind`, since #1680) reloaded correctly but was still captured to error tracking as if unhandled (#3533). `@ifc-lite/geometry` now exports `isWorkerScriptSkewMessage` for the worker-script wrapper signature (`"…worker script failed to load (possibly a stale deployment)"`), and the viewer's `shouldSuppressWasmSkewNoise` matches on it alongside the existing wasm-MIME matcher. Every other pre-pass/worker failure is still captured unchanged.
