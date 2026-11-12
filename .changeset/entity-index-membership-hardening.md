---
"@ifc-lite/parser": patch
---

`CompactEntityIndex.has` keeps its binary search when the membership bitset cannot be allocated, instead of throwing.
