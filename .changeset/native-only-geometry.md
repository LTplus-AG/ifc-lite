---
"@ifc-lite/geometry": minor
---

Add a `requireNative` option to `GeometryProcessor`. When set (with a
`nativeBackendUrl`), `init()` throws `NATIVE_HELPER_UNREACHABLE` if the localhost
helper can't be reached instead of transparently falling back to the in-browser
WASM pipeline — so a native-only app can prompt the user to start the helper
rather than silently running the slower WASM path. The WASM bridge stays in the
bundle (dormant), so the behaviour is reversible by leaving the flag off
(default). Existing callers are unaffected.
