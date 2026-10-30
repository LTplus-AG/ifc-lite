---
"@ifc-lite/wasm": patch
---

With merge layers on, a building element part whose aggregate relationship lists it as a bare reference instead of a list is now skipped like a listed part. Opening propagation already accepted bare references; the merge-layers part map now uses the same aggregate reading. Well-formed files produce the same geometry as before.
