---
"@ifc-lite/sandbox": minor
---

Deliver async bridge results into the sandbox as real promises, and validate `ClashElement.tag` at the boundary (#2305).

A schema method whose `call` returns a Promise — `bim.clash.run` and `bim.clash.matrix` — was marshalled as an ordinary object, so the script received `{}` and the host work carried on unobserved. When it failed, the rejection escaped as an unhandled host rejection: a `ClashElement` without its `tag` produced an uncaught `TypeError: Cannot read properties of undefined (reading 'toUpperCase')` that killed the script run.

Host promises are now handed to the realm via `vm.newPromise()` and settled between QuickJS job drains, bounded by the run's own timeout, so `await bim.clash.run(...)` returns the real result and a host rejection arrives as a catchable `bim.<namespace>.<method>: <message>` script error. `buildBridge` returns an additional `hostWork` queue for that drain. `bim.clash.run` / `bim.clash.matrix` also reject a `ClashElement` without a `tag` up front, naming the element index instead of failing deep inside the engine.
