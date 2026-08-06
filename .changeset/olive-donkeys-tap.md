---
"@ifc-lite/data": patch
---

Cap the `safeUtf8Decode` scratch buffer so an oversized one-off decode no longer retains its full allocation for the lifetime of the realm.

The scratch grew by doubling to the largest subarray ever decoded and was never released. That is the right trade for the 50-500 byte per-entity reads the helper was written for, but a single whole-source decode pushed it to the next power of two above the file size and kept it there: a 342 MB model pinned 512 MB, measured as 30% of the viewer's main-thread heap (#2183).

Decodes at or under 4 MiB keep the existing reused buffer unchanged. Larger ones now get a throwaway buffer, since reuse only pays off for a buffer that is hit repeatedly and a one-off giant decode never is.
