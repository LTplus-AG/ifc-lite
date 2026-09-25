---
"@ifc-lite/create": patch
---

A placement given only an `Axis` of exactly `-X` now writes `RefDirection (0,-1,0)`, the value ifc-lite's own reader uses for an absent RefDirection there, instead of world Y, which rendered it turned 180 degrees compared with before (#5469).
