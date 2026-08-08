---
"@ifc-lite/sandbox": minor
---

Deliver async bridge results into the sandbox as real promises, and validate `ClashElement.tag` at the boundary (#2305).

A schema method whose `call` returns a Promise — `bim.clash.run` and `bim.clash.matrix` — was marshalled as an ordinary object, so the script received `{}` and the host work carried on unobserved. When it failed, the rejection escaped as an unhandled host rejection: a `ClashElement` without its `tag` produced an uncaught `TypeError: Cannot read properties of undefined (reading 'toUpperCase')` that killed the script run.

Host promises are now handed to the realm via `vm.newPromise()` and settled between QuickJS job drains, bounded by the run's own timeout, so `await bim.clash.run(...)` returns the real result and a host rejection arrives as a catchable `bim.<namespace>.<method>: <message>` script error. `buildBridge` returns an additional `hostWork` queue for that drain. `bim.clash.run` / `bim.clash.matrix` also reject a `ClashElement` without a `tag` up front, naming the element index instead of failing deep inside the engine.

Behaviour change for fire-and-forget scripts: a script that calls `bim.clash.run(...)` without awaiting it used to return instantly (with `{}`), because the host work was never waited on. `eval()` now waits for in-flight host work before resolving, bounded by the run's `timeoutMs`, so such a script takes as long as the work it started — or reports `interrupted` if that exceeds the budget.

Also fixed alongside it: disposing a sandbox while a run is parked on host work used to leave the eval-result handle alive, which made `runtime.dispose()` trip the `JS_FreeRuntime` assertion and poison the shared WASM module for the rest of the document (the #1922 failure mode); a run that gives up waiting no longer makes every later run on the same sandbox wait for the same stalled promise; and an error message that already names its own method is no longer prefixed twice (`bim.clash.run: bim.clash.run: ...`).
