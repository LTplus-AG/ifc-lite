---
'@ifc-lite/wasm': patch
---

Skip the content-dedup signature walk on large single-instance faceted BREPs (#1909). A model consisting of one large `IfcFacetedBrep` took ~30 s to reach geometry where web-ifc does open + geometry in ~2.85 s. The cost was not exact arithmetic — a faceted BREP never enters the exact kernel — but a duplicate full traversal: `item_dedup_key` walked every face, bound, loop and point to build a dedup key, mirroring the mesher's own traversal, for a key that cannot pay off when there is exactly one instance.

`item_dedup_key` now skips the signature walk for an `IfcFacetedBrep` above `FACETED_BREP_DEDUP_FACE_LIMIT` (20,000 faces), determined from the shell reference and face-list length without decoding any points.

Dedup and GPU instancing are **not** disabled for large repeated geometry — only the pre-mesh, item-level cache is skipped. `get_or_cache_by_hash` (post-mesh, sampled, O(1) in mesh size) and `direct_rep_identity` still run, so two structurally identical large BREPs still mesh identically and still share a `rep_identity`. That is asserted by test rather than reasoned about, since trading a load-time win for a rendering regression would be a bad bargain. What is genuinely lost is the mesh-skip-on-cache-hit optimisation for a >20k-face item that really is duplicated.

Measured with a deterministic counter rather than wall-clock: on a synthetic 980,000-face BREP, dedup on did 5,880,000 point-cache accesses against 2,940,000 with it off — exactly 2.00× — and 1.00× after the fix.

An end-to-end suite verdict **cannot** be produced for this change and none is claimed: the largest BREP across all 163 fixtures is 8,848 faces, so nothing in the corpus crosses the gate, and a base-vs-branch A/B swings with run order. That finding, and the instruction not to repeat the experiment, are recorded in the perf lever ledger. The 20,000 threshold is a judgement call chosen an order of magnitude clear of realistic repeated parts (connection plates and bolts run to low hundreds of faces), not a measured optimum.
