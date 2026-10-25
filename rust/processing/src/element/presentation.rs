// SPDX-License-Identifier: MPL-2.0
//! Effective, source-free inputs to the last numerical presentation operation.
//! `presentation_source` resolves every source-dependent field (colour,
//! material name, palette selection) and only then builds one of these; the
//! `assembly_*` modules turn it into `MeshData` without a decoder or router.
use super::FullIndexedColourMap;
use crate::types::presentation::{NormalProvenance, UvAuthority};
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
impl<'a> Palette<'a> {
    pub fn get(&self) -> Option<&'a FullIndexedColourMap> {
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
    /// Who wrote `mesh.normals` so far (#7955 J5 provenance).
    pub normals: NormalProvenance,
    /// The textured part's UV authority, judged by source admission and only
    /// when provenance is recorded, so the funnel stays source-free.
    pub uv_authority: Option<UvAuthority>,
    /// How the body's triangles correspond to its palette face set's
    /// `CoordIndex` rows; proven by source admission only when provenance is
    /// recorded, otherwise [`FaceCorrespondence::Unproven`].
    pub faces: FaceCorrespondence,
}

/// What the strategy that produced a sub-mesh collection proves about each
/// part's triangles (#7955 J5). It is derived from the planned strategy, so a
/// part is uncut only by positive proof: a new or unknown strategy is
/// [`Self::MayBeRebuilt`], and only [`Self::ItemsUncut`] lets source
/// admission claim [`FaceCorrespondence::Triangulated`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum CollectionTopology {
    /// The textured strategy on a host with neither a subtracting opening nor
    /// a material-layer slice: each part is its own item's mesher output,
    /// placed, never cut.
    ItemsUncut,
    /// A Boolean void cut or a material-layer slice may have rebuilt a part,
    /// even one whose triangle count is unchanged.
    MayBeRebuilt,
}

/// What source admission proved about triangle `i` of a body being
/// `CoordIndex` row `i` of the face set its palette maps (#7955 J5). Only a
/// proven 1:1 correspondence may back a palette binding.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum FaceCorrespondence {
    /// A per-item body of an `IfcTriangulatedFaceSet` (or TIN) with this
    /// many `CoordIndex` rows, from a collection proven
    /// [`CollectionTopology::ItemsUncut`]. 1:1 when the body still has that
    /// many triangles: the mesher can only drop rows, never add or reorder
    /// them on the colour-mapped (order-keeping) path.
    Triangulated(usize),
    /// An `IfcPolygonalFaceSet`: `ColourIndex` is per face and a face
    /// triangulates to several triangles or none, so no triangle index is a
    /// face index.
    Polygonal,
    /// A void-cut or layer-sliced sub-mesh, a merged or void-cut fallback
    /// body, or a face set that could not be read: nothing proves the
    /// correspondence.
    Unproven,
}

/// When and whether the body reaches the element hasher. The submesh path
/// hashes before the texture/palette decision; the fallback path hashes after
/// it (and after repairing missing normals). Type maps are never hashed.
pub(super) enum HashPolicy {
    Submesh(OrientVerdict),
    Fallback(OrientVerdict),
    Type,
}
