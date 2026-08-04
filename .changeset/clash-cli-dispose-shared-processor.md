---
"@ifc-lite/cli": patch
---

Free the WASM geometry handle `ifc-lite clash` allocates for meshing (#1959).

`clash.ts` lazily creates a module-scoped `sharedProcessor` (`getProcessor()`) the first time a run needs to mesh a model, and reuses it for every subsequent mesh within the same process. It was never disposed on any exit path — success, a thrown clash/BCF error, or an early return — leaking the handle for the life of the process. Low real-world impact (the CLI is a one-shot process, so the OS reclaims the WASM memory on exit either way), but it violates the deterministic-disposal rule the audit in #1959 is checking, so it is fixed to the same shape as the rest of that sweep: the whole run now sits inside `try { … } finally { sharedProcessor?.dispose(); sharedProcessor = undefined; }`, so a subsequent `clashCommand` call in the same process (e.g. a long-lived host embedding the CLI's command functions) starts from a fresh handle instead of accumulating one per call.
