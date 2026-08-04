---
"@ifc-lite/sandbox": patch
---

Fix a double-free in `Sandbox.dispose()` when QuickJS teardown fails.

An out-of-memory or CPU-timeout exception raised inside a drained promise job — an `async function run()` entry point that allocates, for example — leaves QuickJS holding objects with leaked refcounts. Upstream `JS_FreeRuntime` then trips `assert(list_empty(&rt->gc_obj_list))` and throws out of `runtime.dispose()` part-way through freeing the runtime (that abort is upstream in quickjs-emscripten and is not fixed here). `dispose()` left its `runtime` field set afterwards, so every later call — a React cleanup, an extension unload, a defensive re-dispose — re-entered `JS_FreeRuntime` on the same half-freed runtime.

`dispose()` now clears each field before freeing it, and frees the runtime from a `finally` so a throwing `vm.dispose()` no longer strands it for the lifetime of the page. The failure is still reported to the caller.
