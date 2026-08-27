---
'@ifc-lite/geometry': patch
---

Stop widening every window when the authoring tool already cut the hole into the wall.

`extend_opening_mesh_through_host` pushes an opening cutter's cap past a coincident host facet so a flush interface becomes a clean transversal crossing rather than a coplanar graze (issue #1007, host #1112). It qualified a cap on coincidence alone. On a host whose Brep already carries the hole — an Archicad wall exported with "Material Preservation: Explode where necessary", where the wall body lives on aggregated `IfcBuildingElementPart` layers and every layer's Brep has its own window — the cutter's side planes coincide with the hole's jambs, so both jambs read as caps and each was pushed 30% of the opening's span into the pier beside it. Every window came out scaled by exactly 1.600 with its centre unmoved, and the piers between them were eaten; on issue #3219's model that removed 19% to 27% of each wall layer that no authored opening ever occupied.

Coincidence is now necessary but not sufficient. A cap also has to be one the opening EXITS through, decided by the area-weighted orientation of the coincident facets under the cutter's cross-section footprint: with outward winding an exit facet faces away from the host material, while a jamb faces into the hole because the host continues past it. Area weighting keeps facet scatter and stray slivers from outvoting the real surface, and the footprint restriction keeps a large coplanar facet elsewhere on a multi-body host from doing the same. Caps that genuinely exit keep the identical push, so the clearance #1007 depends on is unchanged.

Orientation is read from the host's own signed volume rather than assumed. IFC winding is not reliably outward, and the host reaching this code has not been oriented yet, so an inward-wound body would otherwise lose the clearance push AND get the pier-widening back. A host whose winding is genuinely MIXED can still mis-tally at a cap; that direction is safe (the cap is skipped, costing a rim sliver, never an over-cut) and is tracked separately.

The decision moved to its own module, `router/voids/synthesis/exit_cap.rs`, so the four conditions and their reasons sit together instead of inline in the cutter-synthesis pass.

Verified against ifcopenshell 0.8.2 and manifold3d on the reporter's model, where the correct subtraction removes zero volume because the holes are already present: the four affected wall layers go from -18.8%, -18.6%, -27.0% and -8.3% volume error to within 0.1%. Four regression tests assert removed volume or cutter extent rather than mechanism, because the existing void tests ray-cast "the wall has a hole", which is monotone in the cut and cannot catch an over-cut. They also pin the 30% clearance from both sides for the first time; it previously had no test that could fail at either extreme.

Two thin `IfcCovering` layers on the same model stay wrong for an unrelated reason (multi-opening cuts tear thin shells open, independent of this pad and unchanged by it) and are tracked separately.
