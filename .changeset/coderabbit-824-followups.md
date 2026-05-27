---
"@ifc-lite/viewer": patch
---

Address CodeRabbit feedback from PR #823:

- Auto-populate `modelId` in the Lens rule editor when exactly one federated model is loaded, so the single-model branch (which hides the selector) no longer leaves the rule permanently invalid.
- Fix a `ReferenceError` in `scripts/fetch-prebuilt-wasm.mjs` by routing both prebuilt-fetch and source-build flows through a shared `scripts/lib/patch-threaded-stub.mjs` helper that imports `writeFileSync` and uses a regex anchored on the default export (resilient to wasm-bindgen formatting changes).
- Refresh the stale build-command reference in `@ifc-lite/wasm-threaded`'s package description.

Closes #824.
