---
"@ifc-lite/geometry": patch
"@ifc-lite/parser": patch
"@ifc-lite/viewer": patch
---

Recover from transient WASM engine-load failures and humanise the error.

When the `ifc-lite_bg.wasm` binary fails to download (non-OK HTTP status, a cold
CDN edge, a mid-deploy race, or a blocking proxy/antivirus), wasm-bindgen's
streaming loader rethrows a cryptic `Failed to execute 'compile' on
'WebAssembly': HTTP status code is not ok`. The geometry and parser workers now
retry `init()` once on such fetch/HTTP-shaped failures, and the viewer maps the
failure to actionable guidance ("reload the page") instead of surfacing the raw
TypeError. Captured exceptions are tagged with a stable `error_kind` for triage.
