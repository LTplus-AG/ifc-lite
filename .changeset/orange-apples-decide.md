---
"@ifc-lite/create": patch
---

Share canonical linear element and slab frame geometry readers with the viewer for #6232.

Refuse finite linear-axis components whose magnitude cannot be represented, preserving the unit-axis contract used by split geometry. Large representable axes remain supported.
