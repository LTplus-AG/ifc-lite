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

The walk returns no value, so none of the three bounds reports anything. The
depth cap and the path guard drop the offending sub-tree and nothing else:
those items produce no symbolic geometry, while the rest of the walk continues
normally. The revisit budget is wider than a sub-tree — it is held per
top-level representation item and never restored, so once it is exhausted every
later revisit in that same walk returns early too, and legitimate geometry
reached by a revisit after the cycle is lost with it. Cheap termination is
exactly why the path guard is there, and
`a_cycle_must_not_starve_the_geometry_that_follows_it` pins it. Each top-level
item starts with a fresh budget, so the loss stops at that item's walk. A
malformed file therefore loads with part of its 2D content missing rather than
taking the process down.
