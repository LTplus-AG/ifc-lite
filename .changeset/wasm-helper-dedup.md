---
"@ifc-lite/wasm-lifecycle": minor
"@ifc-lite/geometry": patch
"@ifc-lite/parser": patch
---

New `@ifc-lite/wasm-lifecycle` package: extracts the WASM engine load-retry classification (`initWasmWithRetry`, `isTransientWasmLoadError`) and the cross-realm panic-location forwarder (`takeWasmPanicStash`, `restashWasmPanicLocation`) that `@ifc-lite/geometry` and `@ifc-lite/parser` each carried as an independently-editable "twin" copy, with nothing enforcing the two stayed in sync (#4247).

`@ifc-lite/wasm` — the one package both consumers already depend on — was deliberately not used as the shared home: it ships only the wasm-pack build output with no TypeScript build step, so a hand-written module there would gate every geometry/parser test run on a full Rust→wasm rebuild. `@ifc-lite/wasm-lifecycle` is a plain TypeScript package (its own `tsc` build, same shape as `@ifc-lite/regex-guard`) with no wasm dependency of its own, so it avoids that cost.

`@ifc-lite/geometry` and `@ifc-lite/parser` now each re-export the shared module from their own `wasm-init-retry.ts` / `wasm-panic-forward.ts`, so existing imports are unchanged. No behavior change in either package.
