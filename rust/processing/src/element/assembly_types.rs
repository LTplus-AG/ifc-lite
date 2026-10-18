// SPDX-License-Identifier: MPL-2.0
//! Decoder-free admission of already executed type-map numerical parts.
use super::presentation::{HashPolicy, ReadyBody, ReadyPart, SourceId};
use ifc_lite_geometry::TextureAttachment;
use ifc_lite_geometry::{calculate_normals, Mesh};

pub(super) type TypePart = (Mesh, Vec<f32>, Option<TextureAttachment>);

pub(super) fn ready_type_part(
    mut mesh: Mesh,
    uvs: Vec<f32>,
    texture: Option<TextureAttachment>,
    color: [f32; 4],
    class: u8,
) -> ReadyPart<'static> {
    if mesh.normals.len() != mesh.positions.len() {
        calculate_normals(&mut mesh);
    }
    // Preserve type-map behavior: texture presence selects the UV channel,
    // without imposing the occurrence path's additional length guard.
    let uvs = texture.as_ref().map(|_| uvs);
    ReadyPart::Body(ReadyBody {
        mesh,
        color,
        material_name: None,
        source: SourceId::None,
        class,
        uvs,
        texture,
        palette: None,
        palette_source: SourceId::None,
        hash: HashPolicy::Type,
    })
}
