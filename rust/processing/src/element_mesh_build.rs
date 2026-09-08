// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! `build_mesh_data`, split out of `element.rs` to keep it under the
//! module-size ratchet: the single funnel every element mesh passes through
//! on its way to a [`MeshData`] (degenerate cleanup, the source weld gated by
//! `welded_in_object_frame` (#4122), instancing/placement capture, style and
//! metadata stamping, site-local rotation).

use super::{degenerate, ElementMeshJob, MeshProductionContext};
use crate::processor::convert_mesh_to_site_local;
use crate::types::mesh::MeshData;
use ifc_lite_geometry::Mesh;

/// Construct the final [`MeshData`]: metadata stamp, style metadata,
/// geometry-class tag, and the optional site-local rotation. ALWAYS the last
/// step — geometry hashing happens before this (native IFC frame), which is why
/// the degenerate drop below has to report what it removed: it edits a mesh the
/// hasher has already ruled on.
#[allow(clippy::too_many_arguments)] // distinct per-mesh funnel inputs
pub(super) fn build_mesh_data(
    job: &ElementMeshJob<'_>,
    mut mesh: Mesh,
    color: [f32; 4],
    material_name: Option<String>,
    // The sub-mesh's source id, plus WHAT IT IS. Routed to `geometry_item_id`
    // or `material_id` by `with_style_metadata`, never both (#3199).
    source_id: Option<u32>,
    id_is_material: bool,
    geometry_class: u8,
    ctx: &MeshProductionContext<'_>,
    // Per-vertex texture coordinates (2 per vertex, 1:1 with `mesh.positions`),
    // present only for textured type geometry (#961). Threaded through the weld
    // so the UVs are remapped WITH the deduped positions and stay aligned; a UV
    // difference also keeps a texture seam's coincident corners split.
    uvs: Option<Vec<f32>>,
) -> MeshData {
    // Backstop for f32 vertex-storage collapse, at the single funnel for every
    // element MeshData, tallying what it removed — `produce_element_meshes`
    // drains that tally both into the result and into the closure retraction.
    degenerate::clean(&mut mesh);
    // Source vertex weld, second half (#4103). See `mesh_weld`'s module doc for
    // why a world-frame weld must not touch shared geometry, and `mesh_weld::weld`'s
    // for what legitimately arrives here.
    //
    // `instance_meta` is the discriminator: every producer that sets it
    // (`router::mapped_item`, `stamp_direct_instance`, the don't-bake placeholder)
    // REACHES HERE only through a placement applier, which welds in the OBJECT
    // frame and remaps the UVs with the positions, so those arrive welded with UVs
    // already 1:1; and every step that rebuilds vertices afterwards nulls it
    // (`Mesh::rebuilt_like`, `voids::process_element_with_voids`). "Reaches here"
    // is the load-bearing part, NOT "is baked anywhere":
    // `voids::probe::get_opening_item_meshes_world` bakes with
    // `transform_mesh_world_framed` directly and so DOES produce unwelded meshes
    // carrying `instance_meta`, but they are cutters and volume probes, never
    // element MeshData. `welded_in_object_frame` (#4122) is the real answer.
    debug_assert!(
        mesh.instance_meta.is_none() || mesh.welded_in_object_frame,
        "instance_meta set but welded_in_object_frame is false"
    );
    let welded_uvs = if mesh.instance_meta.is_some() {
        uvs
    } else {
        ifc_lite_geometry::mesh_weld::weld(&mut mesh, uvs)
    };
    let mesh_origin = mesh.origin;
    // Instancing: capture before the fields are moved into MeshData. A site-local
    // rotation (below) re-transforms positions/origin and would invalidate the
    // captured transform, so drop instancing when one is active (rare; conservative).
    let instance = if ctx.site_local_rotation.is_none() {
        mesh.instance_meta.take()
    } else {
        None
    };
    // Local bounds/placement transform (issue #1474): same caveat as instancing
    // above — a site-local rotation re-transforms positions and would invalidate
    // the captured placement, so drop both when one is active.
    let (local_bounds, local_to_world) = if ctx.site_local_rotation.is_none() {
        (mesh.local_bounds, mesh.local_to_world)
    } else {
        (None, None)
    };
    let mut mesh_data = MeshData::new(
        job.id,
        job.ifc_type.name().to_string(),
        mesh.positions,
        mesh.normals,
        mesh.indices,
        color,
    )
    .with_origin(mesh_origin)
    .with_instance(instance)
    .with_local_bounds(local_bounds)
    .with_local_to_world(local_to_world);
    if let Some(meta) = job.metadata {
        mesh_data = mesh_data
            .with_element_metadata(
                meta.global_id.clone(),
                meta.name.clone(),
                meta.presentation_layer.clone(),
            )
            .with_properties(meta.space_zone_properties.clone());
    }
    if material_name.is_some() || source_id.is_some() {
        mesh_data = mesh_data.with_style_metadata(material_name, source_id, id_is_material);
    }
    if geometry_class != 0 {
        mesh_data = mesh_data.with_geometry_class(geometry_class);
    }
    // Attach the welded UVs (kept 1:1 with the welded positions by the weld).
    // The texture IMAGE is attached by the caller; here we only carry the
    // per-vertex coordinates through the funnel so they can't desync.
    mesh_data.uvs = welded_uvs;
    convert_mesh_to_site_local(&mut mesh_data, ctx.site_local_rotation);
    mesh_data
}
