---
'@ifc-lite/parser': patch
---

Bound the `IfcComplexProperty` walk by the number of nested members it reads, not only by depth. A complex property that lists the same member several times was read once per path (`k^8` reads, an 82 MB value for `k = 6`); one walk now reads at most 1024 nested members and marks a cut value with `(truncated: more than 1024 nested properties)`, byte-identical to the server's data model.
