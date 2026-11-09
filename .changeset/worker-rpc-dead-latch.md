---
"@ifc-lite/pointcloud": patch
"@ifc-lite/geometry": patch
---

Worker RPC clients no longer hang when their worker dies. The point-cloud decode worker session now rejects every pending open/next/COPC request on a worker `error` or `messageerror`, terminates the worker, and is evicted from the shared cache so the next load spawns a fresh one; a throwing `postMessage` rejects only its own request. `RemeshClient.create()` now rejects (and terminates the worker) on a `messageerror` during start or when the engine does not report ready within `requestTimeoutMs`, and a request whose post throws no longer leaves a deadline behind that later kills the client under unrelated requests.
