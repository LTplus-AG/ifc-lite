---
"@ifc-lite/ids": patch
---

An entity facet whose name lists several classes (`xs:enumeration`) no longer throws a RangeError when a listed class has more than about 125,000 instances. Its candidates were collected by spreading each class's ids as call arguments, which exceeds the engine's stack, so `validateIDS` rejected and returned no result for the whole document (#7481).
