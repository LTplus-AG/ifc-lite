---
'@ifc-lite/wasm': patch
---

Every boolean op's accept path in `ClippingProcessor` (`subtract_mesh`, `subtract_mesh_many`, `union_mesh`/`union_meshes`, `intersection_mesh`) validates the kernel result for finiteness and index bounds only, so a torn result is accepted as success — issue #3440. A prior change added the closure audit as a reject signal behind the off-by-default `csg_topology_gate` feature, because its predicate reads OPEN edges and a tessellated host carries those benignly.

This adds the reading that has no such excuse. `edge_multiplicity_defects` (new, in `router/voids/prism_cut/closure_checks.rs` alongside the existing predicates, not a fresh definition of watertightness elsewhere) counts UNSIGNED triangle uses per undirected edge on the same 0.1 mm grid and reports two defects the existing audits are structurally blind to: an edge used by more than two triangles, and an edge used twice the same way round. Both audits tally edges with a SIGNED count and pass when everything nets to zero, so an edge used four times — two each way — cancels to exactly zero and reads as closed. An edge used ONCE is deliberately not a defect here; that is the open reading, and the one benign tessellation trips.

Wired at the same four accept paths behind a new `csg_manifold_gate` feature, separate from `csg_topology_gate` so a census can attribute a flip to one defect class rather than to whichever gate fired first. Under the feature a rejected result falls back exactly as an existing `KernelOutputInvalid` already does at each site — un-cut host, empty mesh, or plain merge — and records the new `BoolFailureReason::NonManifoldRejected { over_used, same_direction }` through the same `take_csg_failures` channel. Never an `Err`, so no element is dropped.

No feature, no change: `@ifc-lite/wasm` does not enable `csg_manifold_gate`, so this ships no observable difference to consumers.

It was tried as a default and the measurement says not yet. Over the fixture corpus (115 models, 2071 void hosts) the gate rejects 110 hosts and every one is still cut by a downstream fallback — which looked sufficient. It is not: on this repo's own pinned quality fixtures the fallback is WORSE than the tear it replaces. `issue_098_reveal_wall` goes from ~42 to 380 unpaired edges, `issue_098_v5c` from ~108 to 416, and `issue_960_segmented_roof_clip` grows back the full-height seam sliver that test exists to catch. Rejecting a torn result only helps when what replaces it is better, so the fallback path is what has to be fixed before this can flip.
