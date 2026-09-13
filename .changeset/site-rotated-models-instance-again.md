---
"@ifc-lite/wasm": patch
---

A model whose `IfcSite` placement carries a rotation no longer loses every instancing group. Repeated geometry — occurrences of one `IfcRepresentationMap`, the `IfcMappedItem` case — was shipped once per occurrence on any such model, because the pipeline dropped each mesh's instancing metadata rather than account for the site-frame rotation baked into its vertices. That rotation now travels to the collator as a basis: `collate_refs_in_basis` (renamed from `collate_refs_verified_in`, whose basis argument only steered the verification) conjugates the relative transform it EMITS by that basis as well as the one it checks, so a consumer that reads the transform back places the occurrence in the frame its vertices are in. The glTF exporter and both Parquet routes pass the model's own baked frame; the browser shard path passes none and its bytes are unchanged. A translation-only site placement was already fixed in #4176 and is unaffected.
