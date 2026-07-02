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
layered / unresolved-opening hosts fall back to the per-occurrence path), so it
is never wrong, only sometimes deferred. Default OFF keeps native==wasm
byte-identical until corpus-validated.
