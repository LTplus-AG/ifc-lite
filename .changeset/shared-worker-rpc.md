---
"@ifc-lite/wasm-lifecycle": minor
"@ifc-lite/ids-agent": minor
"@ifc-lite/embed-sdk": patch
"@ifc-lite/pointcloud": patch
"@ifc-lite/geometry": patch
---

Add `createWorkerRpc` to `@ifc-lite/wasm-lifecycle`: one request/response client with a dead latch (the first worker `error`, `messageerror`, missed deadline, failed start or `dispose()` rejects everything pending and every later call), cleanup when a `postMessage` throws, clamped deadlines, abort support and an init handshake. The point-cloud decode worker, the re-mesh client, the IDS agent's worker model bridge and the embed SDK now use it instead of their own copies.

`createWorkerModelBridge` no longer leaves a call made after `dispose()` waiting forever: it rejects at once. Its new `watchErrors` option makes a worker crash or an unreadable message reject every pending and later call. A model-bridge or embed command whose `postMessage` throws no longer leaves a timer and a pending entry behind.
