// SPDX-License-Identifier: MPL-2.0
//! Decoder-free progressive carving of the actual host shell.
use super::stack::VisualLayer;
use crate::csg::{ClippingProcessor, Plane};
use crate::mesh::{SubMesh, SubMeshCollection};
use crate::Mesh;

/// Cut `mesh` into one slab per layer using the pre-computed interface
/// planes. Returns a [`SubMeshCollection`] where each entry's
/// `geometry_id` is the corresponding layer's `material_id` (0 if the
/// layer was an air gap / had no associated material).
///
/// Empty slabs (plane missed the mesh, or clipper returned nothing) are
/// dropped — callers should treat an empty result as "fall back to
/// unsliced mesh".
pub(super) fn slice_mesh_into_layers(
    mesh: &Mesh,
    visual_layers: &[VisualLayer],
    planes: &[Plane],
) -> SubMeshCollection {
    debug_assert_eq!(planes.len() + 1, visual_layers.len());

    let clipper = ClippingProcessor::new();
    // Material-layer ids, not representation items -- see the flag's doc (#3199).
    let mut out = SubMeshCollection::of_materials();

    // Carve each layer's band off a running REMAINDER at the interface planes,
    // and DO NOT cap the cut. Two design choices, one fix:
    //
    //  - No cap. Capping closed every slab, so each SHARED interface became a
    //    doubled, coincident, oppositely-wound full-cross-section sheet: the wall
    //    rendered solid (the interior caps are backface-culled) but the emitted
    //    mesh was non-watertight (degree-4 interface edges) and ~3x the triangles
    //    — the "ghost face" on opening-cut layered walls. Uncapped, each band is
    //    the wall's outer skin within its layer range; the union of the bands is
    //    exactly the wall's watertight outer shell, partitioned per material. The
    //    interface is no longer a 3D sheet; the 2D section re-closes each band's
    //    open contour at the interface chord (its loop builder is bidirectional,
    //    see `drawing-2d` `PolygonBuilder`), so per-layer section fills are intact.
    //
    //  - Progressive carve, not a fresh clone per band. Both sides of every
    //    interface are produced by the SAME clip of the SAME remainder, so their
    //    cut tessellations are identical and the bands weld edge-for-edge (no
    //    T-junctions, no hairline cracks). Clipping independent clones instead let
    //    a twice-clipped middle band diverge from its neighbour at the second
    //    interface, leaving open T-junction edges.
    //
    // `clip_mesh` keeps the half-space the plane normal points INTO and builds a
    // fresh `Mesh` (origin [0,0,0]); the input mesh + planes are in the element's
    // local frame (#1114), so the origin is restored on each band below.
    let mut remainder = mesh.clone();

    for (i, layer) in visual_layers.iter().enumerate() {
        let before_next: Option<&Plane> = if i + 1 == visual_layers.len() {
            None
        } else {
            planes.get(i)
        };

        let mut slab = match before_next {
            Some(plane) => {
                let flipped = Plane::new(plane.point, -plane.normal);
                // band = remainder below the interface; remainder = above it.
                match (
                    clipper.clip_mesh(&remainder, &flipped),
                    clipper.clip_mesh(&remainder, plane),
                ) {
                    (Ok(band), Ok(rest)) => {
                        remainder = rest;
                        band
                    }
                    // Degenerate interface clip: emit the whole remainder for this
                    // layer rather than dropping geometry, and stop carving.
                    _ => std::mem::take(&mut remainder),
                }
            }
            // Last layer: everything left in the remainder.
            None => std::mem::take(&mut remainder),
        };

        slab.origin = mesh.origin;

        if !slab.is_empty() {
            out.sub_meshes.push(SubMesh::new(layer.material_id, slab));
        }
    }

    out
}
