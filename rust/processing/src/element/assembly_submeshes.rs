// SPDX-License-Identifier: MPL-2.0
//! Decoder-free numerical presentation of one admitted body or occurrence.
use super::presentation::{HashPolicy, ReadyBody, SourceId};
use super::{build_mesh_data, AssemblyJob, MeshData, MeshTextureData, RawInstanceOccurrence};
use ifc_lite_geometry::{
    calculate_normals, compose_instance_world_row_major, GeometryHasher, InstanceMeta, Mesh,
};

/// The one body funnel: UV/texture, then the #858 palette split, then one
/// plain mesh. Hashing happens where the body's [`HashPolicy`] says.
pub(super) fn emit_body(
    mut body: ReadyBody<'_>,
    job: &AssemblyJob<'_>,
    rotation: Option<&Vec<f64>>,
    hasher: &mut Option<GeometryHasher>,
) -> Vec<MeshData> {
    if let HashPolicy::Submesh(verdict) = body.hash {
        if let Some(h) = hasher.as_mut() {
            h.add_oriented_mesh(&body.mesh.positions, &body.mesh.indices, body.mesh.origin, verdict);
        }
    }
    // Textured face set (#1781/#961): the UVs ride the source weld (1:1 with
    // positions, seams stay split) and the texture is attached. An occurrence
    // drops the texture instead of sampling garbage if any upstream step
    // rebuilt vertices without the UV channel; a type map selects the channel
    // by texture presence alone, as it always has.
    let texture_valid = body.texture.is_some()
        && match body.hash {
            HashPolicy::Submesh(_) => body
                .uvs
                .as_ref()
                .is_some_and(|uvs| uvs.len() / 2 == body.mesh.positions.len() / 3),
            _ => true,
        };
    if texture_valid {
        let mut data = build(
            job,
            body.mesh,
            body.color,
            body.material_name,
            body.source,
            body.class,
            rotation,
            body.uvs,
        );
        data.texture = body.texture.as_ref().map(MeshTextureData::from_attachment);
        return vec![data];
    }
    // An invalid or missing texture drops its UV channel before palette or
    // plain assembly, exactly as the historical guard did.
    body.uvs = None;
    // #858: a face set with a per-triangle colour map splits into one mesh per
    // palette group (the splitter guards: triangle count must still match, at
    // least two distinct colours). Palette colours supersede the style colour.
    if let Some(full) = body.palette.as_ref().and_then(|palette| palette.get()) {
        if let Some(groups) = crate::style::split_mesh_by_indexed_colour(&body.mesh, full) {
            if let HashPolicy::Fallback(verdict) = body.hash {
                // The split only partitions triangles; the un-split body's
                // verdict is the one that describes this hashed buffer.
                if let Some(h) = hasher.as_mut() {
                    h.add_oriented_mesh(&body.mesh.positions, &body.mesh.indices, body.mesh.origin, verdict);
                }
            }
            return super::assembly_fallback::emit_palette(groups, job, body.palette_source, body.class, rotation);
        }
    }
    if body.mesh.normals.len() != body.mesh.positions.len() {
        calculate_normals(&mut body.mesh);
    }
    if let HashPolicy::Fallback(verdict) = body.hash {
        if let Some(h) = hasher.as_mut() {
            h.add_oriented_mesh(&body.mesh.positions, &body.mesh.indices, body.mesh.origin, verdict);
        }
    }
    vec![build(
        job,
        body.mesh,
        body.color,
        body.material_name,
        body.source,
        body.class,
        rotation,
        body.uvs,
    )]
}

#[allow(clippy::too_many_arguments)] // the resolved last-funnel fields
pub(super) fn build(
    job: &AssemblyJob<'_>,
    mesh: Mesh,
    color: [f32; 4],
    material: Option<String>,
    source: SourceId,
    class: u8,
    rotation: Option<&Vec<f64>>,
    uvs: Option<Vec<f32>>,
) -> MeshData {
    let (id, material_id) = source.fields();
    build_mesh_data(job, mesh, color, material, id, material_id, class, rotation, uvs)
}

/// #1623 Phase 2 don't-bake: a non-template occurrence of a shared template.
/// `transform` was folded into `meta.transform` by `apply_submesh_placement`;
/// the full pre-RTC world transform is composed here and the streaming
/// finalize derives the template-relative mat4.
pub(super) fn occurrence(
    job: &AssemblyJob<'_>,
    source: SourceId,
    meta: &InstanceMeta,
    color: [f32; 4],
) -> RawInstanceOccurrence {
    let (id, material_id) = source.fields();
    let metadata = job.metadata();
    RawInstanceOccurrence {
        express_id: job.id,
        ifc_type: job.ifc_type.name().to_string(),
        global_id: metadata.and_then(|m| m.global_id.clone()),
        name: metadata.and_then(|m| m.name.clone()),
        presentation_layer: metadata.and_then(|m| m.presentation_layer.clone()),
        color,
        rep_identity: meta.rep_identity,
        world_transform: compose_instance_world_row_major(meta),
        // #2985: the id `build_mesh_data` would have stamped had this sub-mesh
        // materialized. ONE home for the #3199 discriminator and the 0-filter.
        geometry_item_id: MeshData::style_geometry_item_id(id, material_id),
    }
}
