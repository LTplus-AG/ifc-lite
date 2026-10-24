---
"@ifc-lite/merge": minor
"@ifc-lite/cli": patch
"@ifc-lite/mcp": patch
"@ifc-lite/collab-server": patch
---

Initialize the shared diff runtime at async content comparison, table rekey, and layer merge boundaries before invoking the synchronous Rust facade. Initialization failures propagate and subsequent requests can retry through the shared runtime.

Library users of synchronous merge planning, rebase, revert, comparison, and snapshot hashing must first await `initDiff()` from `@ifc-lite/diff`. The merge package receives a minor release for this new initialization prerequisite.
