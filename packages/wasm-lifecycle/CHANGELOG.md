# @ifc-lite/wasm-lifecycle

## 0.3.0

### Minor Changes

- [#9535](https://github.com/LTplus-AG/ifc-lite/pull/9535) [`353d056`](https://github.com/LTplus-AG/ifc-lite/commit/353d0569469242c92b709c7ee21a10d3de342e4b) Thanks [@louistrue](https://github.com/louistrue)! - Add `createLifetime` to `@ifc-lite/wasm-lifecycle`: single-flight init with `idle`, `initializing`, `ready`, `failed` and `disposed` states and a generation. Concurrent `init()` calls share one attempt, a failed one is retried, and a `dispose()` makes an in-flight attempt stale, so its success is released instead of resurrecting the resource and its failure never touches the attempt that replaced it. `IfcLiteBridge` and the clash wasm init now use it.
  
  `GeometryProcessor` on the native (Tauri) path no longer builds a new platform bridge on every `init()` call: concurrent and repeated calls share one, `dispose()` now releases it (through the new optional `IPlatformBridge.dispose()`), an `init()` overtaken by `dispose()` rejects instead of installing its bridge, and a failed init is retried.

- [#9534](https://github.com/LTplus-AG/ifc-lite/pull/9534) [`67519f8`](https://github.com/LTplus-AG/ifc-lite/commit/67519f89ef51b53ae6bd1677bec9fd0ef29773f4) Thanks [@louistrue](https://github.com/louistrue)! - Add `createWorkerRpc` to `@ifc-lite/wasm-lifecycle`: one request/response client with a dead latch (the first worker `error`, `messageerror`, missed deadline, failed start or `dispose()` rejects everything pending and every later call), cleanup when a `postMessage` throws, clamped deadlines, abort support and an init handshake. The point-cloud decode worker, the re-mesh client, the IDS agent's worker model bridge and the embed SDK now use it instead of their own copies.
  
  `createWorkerModelBridge` no longer leaves a call made after `dispose()` waiting forever: it rejects at once. Its new `watchErrors` option makes a worker crash or an unreadable message reject every pending and later call. A model-bridge or embed command whose `postMessage` throws no longer leaves a timer and a pending entry behind.

## 0.2.0

### Minor Changes

- [#4306](https://github.com/LTplus-AG/ifc-lite/pull/4306) [`a6976b9`](https://github.com/LTplus-AG/ifc-lite/commit/a6976b9da44d13157533372a8def23995fcfb93f) Thanks [@BIMvoice](https://github.com/BIMvoice)! - New `@ifc-lite/wasm-lifecycle` package: extracts the WASM engine load-retry classification (`initWasmWithRetry`, `isTransientWasmLoadError`) and the cross-realm panic-location forwarder (`takeWasmPanicStash`, `restashWasmPanicLocation`) that `@ifc-lite/geometry` and `@ifc-lite/parser` each carried as an independently-editable "twin" copy, with nothing enforcing the two stayed in sync ([#4247](https://github.com/LTplus-AG/ifc-lite/issues/4247)).
  
  `@ifc-lite/wasm` — the one package both consumers already depend on — was deliberately not used as the shared home: it ships only the wasm-pack build output with no TypeScript build step, so a hand-written module there would gate every geometry/parser test run on a full Rust→wasm rebuild. `@ifc-lite/wasm-lifecycle` is a plain TypeScript package (its own `tsc` build, same shape as `@ifc-lite/regex-guard`) with no wasm dependency of its own, so it avoids that cost.
  
  `@ifc-lite/geometry` and `@ifc-lite/parser` now each re-export the shared module from their own `wasm-init-retry.ts` / `wasm-panic-forward.ts`, so existing imports are unchanged. No behavior change in either package.

### Patch Changes

- [#4379](https://github.com/LTplus-AG/ifc-lite/pull/4379) [`de30321`](https://github.com/LTplus-AG/ifc-lite/commit/de303215ad631d54069067682f443ef33d7d37f3) Thanks [@louistrue](https://github.com/louistrue)! - Add package READMEs documenting the shared regex guard and WASM lifecycle APIs, usage contracts, and limitations.
