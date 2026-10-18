// SPDX-License-Identifier: MPL-2.0
//! Presentation assembly of already executed type-map frame/texture parts.
use super::*;
use ifc_lite_geometry::TextureAttachment;

pub(super) type TypePart = (Mesh, Vec<f32>, Option<TextureAttachment>);

pub(super) fn assemble_type_parts(
    job: &AssemblyJob<'_>,
    rep_map_id: u32,
    geometry_class: u8,
    parts: Vec<TypePart>,
    element_color: [f32; 4],
    ctx: &MeshProductionContext<'_>,
    decoder: &mut EntityDecoder,
) -> Vec<MeshData> {
    let color = resolve_color_for_representation_map(rep_map_id, ctx.geometry_style_index, decoder)
        .unwrap_or(element_color);
    let mut out = Vec::new();
    for (mut mesh, uvs, texture) in parts {
        if mesh.is_empty() {
            continue;
        }
        if mesh.normals.len() != mesh.positions.len() {
            calculate_normals(&mut mesh);
        }
        // UVs participate in the source weld so texture seams remain split.
        let part_uvs = if texture.is_some() { Some(uvs) } else { None };
        let mut data = build_mesh_data(
            job,
            mesh,
            color,
            None,
            None,
            false,
            geometry_class,
            ctx,
            part_uvs,
        );
        if let Some(texture) = texture {
            data.texture = Some(MeshTextureData::from_attachment(&texture));
        }
        out.push(data);
    }
    out
}
