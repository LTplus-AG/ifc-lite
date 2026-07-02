---
"@ifc-lite/geometry": patch
---

Element-level void-cut dedup (#1286 Phase 5), flag-gated OFF
(`IFC_LITE_DEF_DEDUP=1`).

Identical voided elements (same host geometry, opening geometries, and opening
placements relative to the host) currently re-run the exact-kernel CSG cut once
per occurrence. With the flag on, the cut runs ONCE in the host definition frame
(`process_element_with_submeshes_and_voids_unplaced`, reusing the existing
`relativized_by` + `apply_void_context_inner`) and is cached by a void-inclusive
`definition_signature`; each occurrence reuses the template with its own
placement. Eligibility is gated to pure-translation, non-layered hosts (rotated /
layered / unresolved-opening hosts fall back to the per-occurrence path).

Ships flag-gated OFF and STAYS OFF: corpus validation
(`dedup_validate::def_dedup_void_ab`) shows the definition-frame cut is not
byte-identical to the per-occurrence path and is geometrically divergent on real
models (the exact CSG kernel tessellates differently at small definition-frame
coords than at large world coords: dental_clinic tri delta -137, advanced_model
+1876), while the speedup is marginal (1.00x-1.06x where it fires, a 0.97x net
loss on a curved model where no host is eligible). Default OFF keeps the
per-occurrence path as the byte-identical native==wasm ground truth.
