// SPDX-License-Identifier: MPL-2.0
//! Decoder-free numerical presentation of one admitted body or occurrence.
use super::presentation::{HashPolicy, ReadyBody, SourceId};
use super::{build_mesh_data, AssemblyJob, MeshData, MeshTextureData, RawInstanceOccurrence};
use ifc_lite_geometry::{
    calculate_normals, compose_instance_world_row_major, GeometryHasher, Mesh,
};

pub(super) fn emit_body(
    mut body: ReadyBody<'_>,
    job: &AssemblyJob<'_>,
    rotation: Option<&Vec<f64>>,
    hasher: &mut Option<GeometryHasher>,
) -> Vec<MeshData> {
    if let HashPolicy::Submesh(verdict) = body.hash {
        if let Some(h) = hasher.as_mut() {
            h.add_oriented_mesh(
                &body.mesh.positions,
                &body.mesh.indices,
                body.mesh.origin,
                verdict,
            );
        }
    }
    let texture_valid = body.texture.is_some()
        && match body.hash {
            HashPolicy::Submesh(_) => body
                .uvs
                .as_ref()
                .is_some_and(|uvs| uvs.len() / 2 == body.mesh.positions.len() / 3),
            _ => true,
        };
    if texture_valid {
        // Admission preserves the distinct submesh length guard and type-map
        // texture-presence policy. UVs participate in the source weld.
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
    // Invalid/missing textures must drop their UV channel before palette or
    // plain assembly, exactly as the historical submesh guard did.
    body.uvs = None;
    if let Some(full) = body.palette.as_ref().and_then(|palette| palette.get()) {
        if let Some(groups) = crate::style::split_mesh_by_indexed_colour(&body.mesh, full) {
            if let HashPolicy::Fallback(verdict) = body.hash {
                if let Some(h) = hasher.as_mut() {
                    h.add_oriented_mesh(
                        &body.mesh.positions,
                        &body.mesh.indices,
                        body.mesh.origin,
                        verdict,
                    );
                }
            }
            return super::assembly_fallback::emit_palette(
                groups,
                job,
                body.palette_source,
                body.class,
                rotation,
            );
        }
    }
    if body.mesh.normals.len() != body.mesh.positions.len() {
        calculate_normals(&mut body.mesh);
    }
    if let HashPolicy::Fallback(verdict) = body.hash {
        if let Some(h) = hasher.as_mut() {
            h.add_oriented_mesh(
                &body.mesh.positions,
                &body.mesh.indices,
                body.mesh.origin,
                verdict,
            );
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
    build_mesh_data(
        job,
        mesh,
        color,
        material,
        id,
        material_id,
        class,
        rotation,
        uvs,
    )
}

pub(super) fn occurrence(
    job: &AssemblyJob<'_>,
    source: SourceId,
    im: &ifc_lite_geometry::InstanceMeta,
    color: [f32; 4],
) -> RawInstanceOccurrence {
    let (id, material_id) = source.fields();
    RawInstanceOccurrence {
        express_id: job.id,
        ifc_type: job.ifc_type.name().to_string(),
        global_id: job
            .metadata()
            .and_then(|metadata| metadata.global_id.clone()),
        name: job.metadata().and_then(|metadata| metadata.name.clone()),
        presentation_layer: job
            .metadata()
            .and_then(|metadata| metadata.presentation_layer.clone()),
        color,
        rep_identity: im.rep_identity,
        world_transform: compose_instance_world_row_major(im),
        geometry_item_id: MeshData::style_geometry_item_id(id, material_id),
    }
}
