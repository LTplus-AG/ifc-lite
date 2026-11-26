---
"@ifc-lite/export": patch
---

Keep a later compatible occurrence of a GlobalId in merged exports when schema pruning removes the earlier occurrence. The later model's references to it resolve to the surviving record. A later relationship that claims a single-valued inverse an omitted earlier relationship already held is still dropped.
