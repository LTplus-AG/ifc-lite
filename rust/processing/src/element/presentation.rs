// SPDX-License-Identifier: MPL-2.0
//! Effective, source-free inputs to the last numerical presentation operation.
//! `presentation_source` resolves every source-dependent field (colour,
//! material name, palette selection) and only then builds one of these; the
//! `assembly_*` modules turn it into `MeshData` without a decoder or router.
use super::FullIndexedColourMap;
use ifc_lite_geometry::{Mesh, OrientVerdict, TextureAttachment};
use rustc_hash::FxHashMap;

/// Collection provenance is resolved before consuming its first part. A
/// material id must never become a geometry-item id, including on occurrences.
#[derive(Clone, Copy)]
pub(super) enum SourceId {
    None,
    Geometry(u32),
    Material(u32),
}
impl SourceId {
    pub fn collection(id: u32, materials: bool) -> Self {
        if materials {
            Self::Material(id)
        } else {
            Self::Geometry(id)
        }
    }
    /// `(source id, id is a material)`, the two `build_mesh_data` inputs.
    pub fn fields(self) -> (Option<u32>, bool) {
        match self {
            Self::None => (None, false),
            Self::Geometry(id) => (Some(id), false),
            Self::Material(id) => (Some(id), true),
        }
    }
}

/// The selected palette, by key into the caller's borrowed index: no per-part
/// copy, and no lookup until assembly has hashed and rejected the UV/texture
/// path. The key is the selected map key, not its possibly malformed
/// embedded geometry_id.
pub(super) struct Palette<'a> {
    pub maps: &'a FxHashMap<u32, FullIndexedColourMap>,
    pub key: u32,
}
impl Palette<'_> {
    pub fn get(&self) -> Option<&FullIndexedColourMap> {
        self.maps.get(&self.key)
    }
}

/// One admitted body. Everything a mesh needs is resolved; nothing here can
/// read source.
pub(super) struct ReadyBody<'a> {
    pub mesh: Mesh,
    pub color: [f32; 4],
    pub material_name: Option<String>,
    pub source: SourceId,
    pub class: u8,
    pub uvs: Option<Vec<f32>>,
    pub texture: Option<TextureAttachment>,
    pub palette: Option<Palette<'a>>,
    /// The id the palette-split parts are stamped with.
    pub palette_source: SourceId,
    pub hash: HashPolicy,
}

/// When and whether the body reaches the element hasher. The submesh path
/// hashes before the texture/palette decision; the fallback path hashes after
/// it (and after repairing missing normals). Type maps are never hashed.
pub(super) enum HashPolicy {
    Submesh(OrientVerdict),
    Fallback(OrientVerdict),
    Type,
}
