---
"@ifc-lite/parser": patch
---

`CompactEntityIndex.has` answers from a membership bitset built once after warm-up (dense id ranges only) instead of a binary search per call; relationship queries filter every related id through it.
