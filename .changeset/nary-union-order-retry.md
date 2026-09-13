---
"@ifc-lite/wasm": patch
---

A 3-operand union (`union_many`) no longer tears depending on which order the operands were supplied in. `promote_operands_mutually` welds operands in array order, so which operand a caller places first could decide whether a third operand ever reconciled with the other two; the committed #3913/#3916 sweep measured 136 of 882 configurations torn, all caller-order-dependent, with a closed result always reachable under some other ordering of the same 3 operands. `union_many` now retries the other orderings of a 3-operand union only when the caller's own order comes back open (checked the same way a real caller's `consolidate_coplanar` output is checked), keeping the caller's order unchanged whenever it already closes. The sweep now measures 0 of 882 torn under every ordering. Unions of 2 or 4+ operands are unaffected.
