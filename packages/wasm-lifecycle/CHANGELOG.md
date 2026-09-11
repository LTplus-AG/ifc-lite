# @ifc-lite/wasm-lifecycle

## 0.2.0

### Minor Changes

- [#4306](https://github.com/LTplus-AG/ifc-lite/pull/4306) [`a6976b9`](https://github.com/LTplus-AG/ifc-lite/commit/a6976b9da44d13157533372a8def23995fcfb93f) Thanks [@BIMvoice](https://github.com/BIMvoice)! - New `@ifc-lite/wasm-lifecycle` package: extracts the WASM engine load-retry classification (`initWasmWithRetry`, `isTransientWasmLoadError`) and the cross-realm panic-location forwarder (`takeWasmPanicStash`, `restashWasmPanicLocation`) that `@ifc-lite/geometry` and `@ifc-lite/parser` each carried as an independently-editable "twin" copy, with nothing enforcing the two stayed in sync ([#4247](https://github.com/LTplus-AG/ifc-lite/issues/4247)).
  
  `@ifc-lite/wasm` — the one package both consumers already depend on — was deliberately not used as the shared home: it ships only the wasm-pack build output with no TypeScript build step, so a hand-written module there would gate every geometry/parser test run on a full Rust→wasm rebuild. `@ifc-lite/wasm-lifecycle` is a plain TypeScript package (its own `tsc` build, same shape as `@ifc-lite/regex-guard`) with no wasm dependency of its own, so it avoids that cost.
  
  `@ifc-lite/geometry` and `@ifc-lite/parser` now each re-export the shared module from their own `wasm-init-retry.ts` / `wasm-panic-forward.ts`, so existing imports are unchanged. No behavior change in either package.

### Patch Changes

- [#4379](https://github.com/LTplus-AG/ifc-lite/pull/4379) [`de30321`](https://github.com/LTplus-AG/ifc-lite/commit/de303215ad631d54069067682f443ef33d7d37f3) Thanks [@louistrue](https://github.com/louistrue)! - Add package READMEs documenting the shared regex guard and WASM lifecycle APIs, usage contracts, and limitations.
