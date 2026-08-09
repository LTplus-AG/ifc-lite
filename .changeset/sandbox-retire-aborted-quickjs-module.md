---
"@ifc-lite/sandbox": minor
---

Survive the upstream QuickJS teardown abort (#1922) by retiring the WASM module it poisons, instead of leaving every later sandbox in the process on it.

A script that exhausts the memory limit inside a *drained promise job* — the reported shape is the post-`await` body of an `async function run()` — leaves objects orphaned on `rt->gc_obj_list` with leaked refcounts, and upstream `JS_FreeRuntime` asserts that list is empty. `runtime.dispose()` therefore comes back as `Aborted(Assertion failed: list_empty(&rt->gc_obj_list))`. That is an emscripten `abort()`, and its `ABORT` flag is latched **per module instance** — so on the process-wide module behind `getQuickJS()`, which every sandbox shared, the first abort was also the last one that could report itself: a second runtime left in exactly the same broken state disposed "successfully" while silently leaking whatever `JS_FreeRuntime` had not reached (measured: `#1 -> ABORT`, `#2 -> CLEAN`). In the browser the shared module also took scripting down with it until a page reload.

The abort itself is upstream and still unfixed — quickjs-emscripten 0.32 exposes no GC entry point, and forcing a collection, lifting the limit, re-draining the job queue and skipping the context free were all measured against the reproducer and all still abort. What is new is that it is no longer terminal:

- `Sandbox` now acquires its module through this package's own cache (`newQuickJSWASMModule()`, which is exactly what `getQuickJS()` memoizes) and remembers which instance its runtime came from.
- A `runtime.dispose()` that aborts retires that module, so the *next* `Sandbox.init()` instantiates a fresh one — measured at 1-5 ms and ~1-2 MB, and only ever on this path. A later abort then reports itself again, because the new module's latch has not fired.
- Retiring also unpins the poisoned module, which upstream's singleton held for the life of the process.
- New `Sandbox.moduleRetired` tells a long-lived host (an extension runtime) that its sandbox is running on a module whose latch has fired: it still executes scripts, but can no longer report its own teardown, so it should be discarded and recreated.
- `isSandboxRuntimeAborted()` is unchanged in shape and still latched, but is now documented as a diagnostic rather than a health check — a `true` no longer means scripting is dead.
- `SandboxAbortError`'s message says the module was retired and the next sandbox will be fresh, instead of advising a reload.

Minor rather than major: nothing is removed or renamed. The package's export list is unchanged (`check:api-surface` reports no diff), `isSandboxRuntimeAborted()` keeps its signature and its trigger — true iff a teardown abort has happened in this process — and every existing call still compiles and still means what it meant. What is added is `Sandbox.moduleRetired`; what changes is behaviour on a path that previously ended in a dead module, so no working caller can regress.
