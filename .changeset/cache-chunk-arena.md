---
"@ifc-lite/cache": minor
"@ifc-lite/viewer": patch
---

Decoding a cached geometry chunk copies mesh positions, normals and indices into shared, aligned ~1 MiB blocks (`ArrayArena`, opt-in on `BufferReader`) instead of one ArrayBuffer per array.
