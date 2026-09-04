---
'@ifc-lite/wasm': patch
---

Every boolean op's accept path in `ClippingProcessor` (`subtract_mesh`, `subtract_mesh_many`, `union_mesh`/`union_meshes`, `intersection_mesh`) validated the kernel result for finiteness and index bounds only, so a torn result was accepted and shipped as a success — issue #3440. A prior change added the closure audit as a reject signal, but left it behind the off-by-default `csg_topology_gate` feature because its predicate reads OPEN edges, and a tessellated host routinely carries those from T-junction subdivision alone.

This adds the reading that has no such excuse, on by default. `edge_multiplicity_defects` (new, in `router/voids/prism_cut/closure_checks.rs` alongside the existing predicates, not a fresh definition of watertightness elsewhere) counts UNSIGNED triangle uses per undirected edge on the same 0.1 mm grid and reports two defects the existing audits are structurally blind to: an edge used by more than two triangles, and an edge used twice the same way round. Both audits tally edges with a SIGNED count and pass when everything nets to zero, so an edge used four times — two each way — cancels to exactly zero and reads as closed. An edge used ONCE is deliberately not a defect here; that is the open reading, and the one benign tessellation trips.

A rejected result falls back exactly as an existing `KernelOutputInvalid` already does at each site — un-cut host, empty mesh, or plain merge — and records the new `BoolFailureReason::NonManifoldRejected { over_used, same_direction }` through the same `take_csg_failures` / per-host diagnostics channel. It is never an `Err`, so no element is dropped: it keeps its geometry, just the un-cut version, with a diagnostic saying so.

Measured over the fixture corpus (115 models, 2071 void hosts) rather than argued: 110 hosts reject, and all 110 are still cut by a downstream fallback — none lose their opening. The census is checked in as `rust/geometry/tests/issue_3440_manifold_gate_census.rs`.
