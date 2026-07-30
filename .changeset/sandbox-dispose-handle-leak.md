---
"@ifc-lite/sandbox": patch
---

Fix `sandbox.dispose()` aborting the whole QuickJS WASM module when a `bim.*` result could not be marshalled. Handles created through a QuickJS context are unmanaged lifetimes — `context.dispose()` does not free them — so a container handle orphaned by a mid-marshal exception (a throwing getter, a revoked `Proxy`, any host error raised while a result was being converted) kept a JSObject on the runtime's GC list and made `JS_FreeRuntime` assert `list_empty(&rt->gc_obj_list)`. Emscripten then `abort()`ed, leaving the sandbox unusable until a page reload. The bridge now owns every handle it creates across throws (`marshalValue`, namespace registration, the `bim` and `console` globals), and the disposable result of `executePendingJobs()` is freed instead of dropped. Script errors surface unchanged; only the abort is gone.
