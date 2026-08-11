---
"@ifc-lite/wasm": patch
---

Fix the wasm panic hook so it actually survives `new IfcAPI()`: every realm was constructing an
`IfcAPI` before doing any work, and `IfcAPI::new()` called `console_error_panic_hook::set_once()`
directly — which owns its own `Once` and unconditionally replaces whatever panic hook is currently
installed. That silently overwrote the panic-location-stashing hook installed at module init,
so `globalThis.__ifclite_wasm_panic` was never written and the source-location attribution added
for #2527 was inert in production. `IfcAPI::new()` now calls the crate's own idempotent
`set_panic_hook()`, which no-ops if the stashing hook is already installed.

This is a runtime behavior change for the published `@ifc-lite/wasm` package: every uncaught Rust
panic now stashes `{ location, at }` on the realm's JS global (source location only, sanitised of
build-machine paths — never the panic message) for the duration of the panic hook's lifetime, where
downstream consumers (the viewer's error tracking) can read and consume it.
