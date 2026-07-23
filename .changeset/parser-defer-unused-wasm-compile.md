---
'@ifc-lite/parser': patch
---

Parser worker: skip the ~3.9 MB WASM scanner compile on the streaming cold-load
path where it is never used. When the host promises an entity-index handoff
(`waitForEntityIndex`, gated on files ≥2 MB), the geometry pre-pass builds the
index and the entity scanner resolves from it, short-circuiting before the WASM
scan ever runs — so eager-compiling the engine binary there only stole a core
from the concurrent pre-pass. The compile is now deferred: eager on the
no-handoff path, and lazy on the fallback branch if the promised index never
arrives. Behaviour is unchanged (a new test pins that a pre-scanned index
resolves with no `wasmApi`).
