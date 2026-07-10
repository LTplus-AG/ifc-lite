---
"@ifc-lite/cli": patch
---

`extract-entities` fixes: void/fill relations now close over their own references (a
relation-only OwnerHistory no longer leaves a dangling `#ref` in the subset), raw
Latin-1 high bytes round-trip byte-identically instead of being mangled to U+FFFD,
and files beyond the V8 string cap fail with a clear error instead of crashing.
