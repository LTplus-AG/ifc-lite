---
"@ifc-lite/wasm": minor
"@ifc-lite/parser": patch
---

The WebAssembly entity scan now reports dropped and skipped records through `onDiagnostic`, the same as the TypeScript tokenizer (#7393). `scanEntitiesFast` and `scanEntitiesFastBytes` still return an array, which now also carries `oversizedIdCount` and `malformedRecordCount` properties. `parseColumnar` with `wasmApi` passes both counts to `onDiagnostic` using the same messages as the tokenizer path, and to `EntityScanResult`. Each refusal is still logged to the console once.
