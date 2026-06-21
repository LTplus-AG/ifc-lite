---
"@ifc-lite/geometry": patch
---

Fix GPU instancing dropping repeated geometry ("missing objects" under #1238).

The sub-mesh placement path (`apply_submesh_placement`) — taken by every
multi-item element, which is all Tekla-style steel (beams, plates, assemblies)
— baked the element's world placement into the vertices but never recorded it
into `instance_meta.transform`, leaving the IDENTITY placeholder. The single-mesh
path (`apply_placement`) already records it; the sub-mesh path did not. So
`collate_refs` computed `rel_k = m_k · m_ref⁻¹ = identity` for every occurrence
of a template and they all stacked on the first one, leaving every other position
empty. The flat (non-instanced) path was always correct, and content-dedup made
it look like ~half the model was gone. Now each sub-mesh records the scaled
per-element placement before baking, mirroring the single-mesh path.
