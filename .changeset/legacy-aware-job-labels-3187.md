---
"@ifc-lite/wasm": patch
---

Resolve geometry-job types legacy-aware in all three browser pre-pass discovery paths, so a job's label agrees with the gate that admitted it.

Seven sites across `styling/prepass.rs`, `gpu_meshes/prepass.rs` and `gpu_meshes/prepass_discovery.rs` resolved a job's type with a bare `IfcType::from_str`, which knows only the current schema. A keyword a newer schema dropped came back `IfcType::Unknown(crc32)`, while the gate that admitted the job (`has_geometry_by_name`) resolved it legacy-aware. The label and the gate disagreed.

**Scope, stated precisely: this is a consistency fix, not a user-visible one.** The label these sites compute does not currently reach the wire. `emit_jobs_chunk` writes three slots per job (`id`, `start`, `end`) and drops the type, and the worker re-derives it from the record with `legacy_aware_ifc_type_from_record`, which is where #3179 was actually fixed. So the wrong labels were dead data. What this changes is that the field stops being an `Unknown` waiting to surface the moment anything reads it, and the two branches of the same walk stop contradicting each other.

The sites are reachable rather than theoretical: enumerating `LEGACY_ENTITY_NAMES` against `has_geometry_by_name` gives 22 keywords that reach these branches and are `Unknown` under the bare resolver. Measured against the generated per-version tables, they split:

- **10 IFC4-only**, removed in IFC4X3: the `StandardCase` / `ElementedCase` family
- **7 IFC2X3-only**: `IFCEQUIPMENTELEMENT`, `IFCELECTRICDISTRIBUTIONPOINT`, `IFCELECTRICALELEMENT`, the two edge-feature leaves, the two `...ActionVarying` leaves
- **2 in both**: `IFCPROXY`, `IFCBUILDINGELEMENT`
- **3 in neither**: the IFC4X3 stratum leaves

The seventh site is the reason this is worth doing now: it is in the sharded column-discovery walk, and its sibling branch eight lines above already resolves legacy-aware, under a comment stating that the label can never disagree with the gate that admitted it. The geometry-job branch below it was the counterexample to that comment.
