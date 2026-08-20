---
'@ifc-lite/wasm': patch
---

Symbolic (2D) extraction no longer aborts the process on a cyclic or
explosively branching representation-item graph. `extract_symbolic_item`
followed file-supplied item references with no depth cap, no cycle guard and no
work budget, so a self-referential item overflowed the stack — an abort rather
than a catchable panic, killing the load outright.

Three bounds now travel with the walk: a depth cap of 32, a path-scoped
re-entry check that breaks cycles, and a budget of 200,000 revisits (first
visits are free, since their number is bounded by the file; only revisits can
fan out exponentially).

The walk returns no value, so none of the three bounds reports anything. At
each one the offending sub-tree is simply dropped: those items produce no
symbolic geometry, while everything outside the sub-tree extracts normally. A
malformed file therefore loads with part of its 2D content missing rather than
taking the process down.
