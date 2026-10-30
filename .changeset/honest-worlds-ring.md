---
"@ifc-lite/merge": minor
---

Initialize the shared diff runtime at async content comparison, table rekey, and layer merge boundaries before invoking the synchronous Rust facade. Initialization failures propagate and subsequent requests can retry through the shared runtime.

Library users of synchronous merge planning, rebase, revert, comparison, and snapshot hashing must first initialize the shared runtime from `@ifc-lite/diff`, either with `await initDiff()` or, with preloaded WASM input, `initDiffSync(...)`. The merge package receives a minor release for this new initialization prerequisite.
