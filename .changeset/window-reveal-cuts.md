---
"@ifc-lite/wasm": patch
---

Restore inner reveal faces for window and door openings cut from walls, with axis-clamped quads that work for any wall orientation. Rebuilds the WASM bundle with the new reveal generation and defensive guards (full cross-axis overlap check + orthogonal-axis clamp) so multi-layer wall sub-meshes never receive floating reveal quads and skipped openings from the triangle-cap safety path don't leave phantom interior faces.
