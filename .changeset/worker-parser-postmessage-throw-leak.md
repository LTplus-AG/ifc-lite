---
"@ifc-lite/parser": patch
---

Fix `WorkerParser.parseColumnar` leaking its spawned worker thread when `postMessage` itself throws.

The worker is spawned, assigned to `this.worker`, and its handlers wired before `worker.postMessage(input)` runs as the Promise executor's last statement, unguarded. A structured-clone failure (e.g. `DataCloneError`) thrown from `postMessage` auto-rejects the returned promise via the executor's implicit catch, but nothing on that path called `settle()`/`terminate()` — the worker thread was left running and `this.worker` left pointing at it. `postMessage` is now wrapped in try/catch and a throw is routed through `settle()` so the worker is always torn down.
