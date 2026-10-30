// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! The server's wire mesh: the shared `ifc-lite-processing` mesh plus the
//! IFC-authored finish (#5984).
//!
//! `ifc_lite_processing::MeshData` has no finish field, and gets none, because
//! that crate is published and a new pub field on a struct-literal type is a
//! semver major (#5582). This crate is not published, so the finish rides here:
//! the processing mesh flattened into the same JSON object, beside optional
//! `metallic` / `roughness` keys, which is exactly the shape
//! `@ifc-lite/server-client`'s `MeshData` reads. A mesh without a finish
//! serializes byte-for-byte as it did before.
//!
//! Every read of a mesh field goes through `Deref`, so the transports treat
//! this as the processing mesh; only the four places meshes enter the server
//! (the JSON, Parquet and optimized-Parquet routes, and the streaming producer)
//! build it, from the pass's own `on_finishes` events (#8341 C4-13a): each
//! asks for them with [`with_finishes`], and the three full-pass routes
//! collect them with [`CollectedFinishes`].

use ifc_lite_processing::style::SpecularMaterial;
use ifc_lite_processing::{ProcessingRequest, ProcessingSink};
use serde::{Deserialize, Serialize};

/// One produced mesh as the server transports ship it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MeshData {
    #[serde(flatten)]
    pub mesh: ifc_lite_processing::MeshData,
    /// IFC-authored metallic factor in `[0, 1]`; absent when unauthored.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metallic: Option<f32>,
    /// IFC-authored roughness in `[0, 1]`; absent when unauthored. An authored
    /// `0` (a mirror-smooth glass) is a value, not an absence.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub roughness: Option<f32>,
}

impl MeshData {
    /// Attach the finish the pass's `on_finishes` reported for `mesh`.
    pub fn with_finish(mesh: ifc_lite_processing::MeshData, finish: Option<SpecularMaterial>) -> Self {
        let finish = finish.unwrap_or_default();
        Self { mesh, metallic: finish.metallic, roughness: finish.roughness }
    }

    /// The finish as the Parquet columns carry it: `[metallic, roughness]`,
    /// `NaN` for an unauthored field (the same encoding as the wasm
    /// `styleFinishes` wire, `ifc_lite_processing::prepass::finish_to_wire`).
    pub fn finish_wire(&self) -> [f32; 2] {
        [self.metallic.unwrap_or(f32::NAN), self.roughness.unwrap_or(f32::NAN)]
    }
}

impl From<ifc_lite_processing::MeshData> for MeshData {
    fn from(mesh: ifc_lite_processing::MeshData) -> Self {
        Self::with_finish(mesh, None)
    }
}

impl std::ops::Deref for MeshData {
    type Target = ifc_lite_processing::MeshData;
    fn deref(&self) -> &Self::Target {
        &self.mesh
    }
}

impl std::ops::DerefMut for MeshData {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.mesh
    }
}

/// `request` with `Features::finishes` on: the pass raises `on_finishes`
/// before every batch, joined by `ifc_lite_processing::style::finish_join`'s
/// rule (the finish of the style the mesh's colour came from) over the pass's
/// own scan, so no route reads the file a second time for it.
pub fn with_finishes(request: ProcessingRequest) -> ProcessingRequest {
    let features = request.features.finishes(true);
    request.features(features)
}

/// The sink of a full-pass route that reads its meshes off the result: every
/// `on_finishes` entry, in emission order.
#[derive(Default)]
pub struct CollectedFinishes(Vec<Option<SpecularMaterial>>);

impl ProcessingSink for CollectedFinishes {
    fn on_finishes(&mut self, finishes: &[Option<SpecularMaterial>]) {
        self.0.extend_from_slice(finishes);
    }
}

impl CollectedFinishes {
    /// Pair each retained mesh with its finish. Without instancing (no route
    /// arms it) the pass retains exactly the meshes it emitted, in emission
    /// order, so entry `i` is mesh `i`'s.
    pub fn attach(self, meshes: Vec<ifc_lite_processing::MeshData>) -> Vec<MeshData> {
        debug_assert_eq!(self.0.len(), meshes.len(), "one finish per emitted mesh");
        pair(meshes, self.0)
    }
}

/// Mesh `i` with finish `i`; a mesh past the end of `finishes` has none.
pub fn pair(
    meshes: impl IntoIterator<Item = ifc_lite_processing::MeshData>,
    finishes: Vec<Option<SpecularMaterial>>,
) -> Vec<MeshData> {
    let finishes = finishes.into_iter().chain(std::iter::repeat(None));
    meshes.into_iter().zip(finishes).map(|(mesh, finish)| MeshData::with_finish(mesh, finish)).collect()
}

/// Test builders mirroring the processing mesh's, so a fixture reads the same
/// either side of the wrapper.
#[cfg(test)]
impl MeshData {
    pub fn new(
        express_id: u32,
        ifc_type: String,
        positions: Vec<f32>,
        normals: Vec<f32>,
        indices: Vec<u32>,
        color: [f32; 4],
    ) -> Self {
        ifc_lite_processing::MeshData::new(express_id, ifc_type, positions, normals, indices, color).into()
    }

    pub fn with_origin(self, origin: [f64; 3]) -> Self {
        Self { mesh: self.mesh.with_origin(origin), ..self }
    }

    pub fn with_instance(self, instance: Option<ifc_lite_geometry::InstanceMeta>) -> Self {
        Self { mesh: self.mesh.with_instance(instance), ..self }
    }

    pub fn with_geometry_class(self, geometry_class: u8) -> Self {
        Self { mesh: self.mesh.with_geometry_class(geometry_class), ..self }
    }

    pub fn with_style_metadata(self, material_name: Option<String>, source_id: Option<u32>, id_is_material: bool) -> Self {
        Self { mesh: self.mesh.with_style_metadata(material_name, source_id, id_is_material), ..self }
    }
}
