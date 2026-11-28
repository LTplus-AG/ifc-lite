---
"@ifc-lite/export": patch
---

Keep a later compatible occurrence of a GlobalId in merged exports when schema pruning removes the earlier occurrence. The later model's references to it resolve to the surviving record. Relationships to the survivor can reclaim a single-valued inverse when pruning removes its earlier relationship.
