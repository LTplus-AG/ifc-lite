---
'@ifc-lite/wasm': patch
---

Bump the pinned wasm-bindgen family to 0.2.126 (js-sys/web-sys 0.3.103,
wasm-bindgen-futures 0.4.76, wasm-bindgen-test 0.3.76). They move together because
js-sys and web-sys pin wasm-bindgen exactly.

This unblocks gate 1 of the WASM wide-arithmetic tripwire: wasm-bindgen 0.2.106's
bundled `walrus` parser could not read a wide-arithmetic code section, so the
`pkg-wide` bundle failed to build at all. It builds now.

No API or behaviour change for consumers. The generated TypeScript surface is
unchanged — 557 normalised signature units, identical before and after; the large
`ifc-lite.d.ts` diff is indentation, member ordering and newly emitted doc comments.
The pinned wasm32 mesh-determinism manifest still matches, so emitted mesh bytes are
unchanged. Default, threaded and wide bundles all build and pass their litmus checks.
