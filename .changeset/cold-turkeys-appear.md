---
"@ifc-lite/parser": patch
---

Reduce cold IFC parsing work by reusing ordered entity references, avoiding redundant sorting, and limiting georeferencing property-set discovery without changing the parser API.
