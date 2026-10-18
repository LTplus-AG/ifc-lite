// SPDX-License-Identifier: MPL-2.0
//! Presentation assembly for a merged fallback frame part.
use super::*;

/// Emit one assembled fallback body (a single frame part): outward winding,
/// the #858 indexed-colour split when it still applies, else one mesh.
pub(super) fn emit_fallback_mesh(
    job: &AssemblyJob<'_>,
    mut mesh: Mesh,
    element_color: [f32; 4],
    ctx: &MeshProductionContext<'_>,
    decoder: &mut EntityDecoder,
    hasher: &mut Option<GeometryHasher>,
) -> Vec<MeshData> {
    // Make the assembled body consistently outward-wound. A faceted brep (IFC
    // face loops are not reliably outward) or a merged multi-item body (extrusion
    // unioned with a boolean cut) can carry MIXED winding that corrupts signed
    // volume and the smooth normals computed below. No-op for already-consistent
    // bodies (every extrusion), so their index buffer + normals are untouched; a
    // flip invalidates any baked normals, so recompute them.
    //
    // The verdict rides along to the hasher below: this pass is the only place
    // that knows whether the assembled body is a closed orientable solid, and
    // without that a per-element volume cannot be emitted honestly (#1891).
    let verdict = orient_mesh_outward_verdict(&mut mesh);
    if verdict.flipped {
        calculate_normals(&mut mesh);
    }

    // Multi-colour IfcIndexedColourMap → one mesh per palette group (#858),
    // resolved by walking the element's representation for the colour-mapped
    // face set. Only applies while the produced triangle count still matches
    // the face set's CoordIndex (no CSG/void retopology) — the splitter
    // guards this; otherwise the single dominant-coloured mesh below wins.
    if !ctx.indexed_colour_full.is_empty() {
        if let Some(full) =
            find_indexed_colour_for_element(job.entity, ctx.indexed_colour_full, decoder)
        {
            let geometry_id = full.geometry_id;
            if let Some(groups) = crate::style::split_mesh_by_indexed_colour(&mesh, full) {
                if let Some(h) = hasher.as_mut() {
                    // The palette split below only partitions triangles; the
                    // verdict from the un-split body is the one that describes
                    // this hashed buffer.
                    h.add_oriented_mesh(&mesh.positions, &mesh.indices, mesh.origin, verdict);
                }
                let mut out: Vec<MeshData> = Vec::with_capacity(groups.len());
                for (color, mut part) in groups {
                    if part.normals.len() != part.positions.len() {
                        calculate_normals(&mut part);
                    }
                    out.push(build_mesh_data(
                        job,
                        part,
                        color.to_array(),
                        None,
                        Some(geometry_id),
                        false,
                        0,
                        ctx,
                        None,
                    ));
                }
                if !out.is_empty() {
                    return out;
                }
            }
        }
    }

    if mesh.normals.len() != mesh.positions.len() {
        calculate_normals(&mut mesh);
    }
    if let Some(h) = hasher.as_mut() {
        h.add_oriented_mesh(&mesh.positions, &mesh.indices, mesh.origin, verdict);
    }
    vec![build_mesh_data(
        job,
        mesh,
        element_color,
        None,
        None,
        false,
        0,
        ctx,
        None,
    )]
}
