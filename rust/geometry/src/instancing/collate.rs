// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::group::collate_refs;
use crate::mesh::{InstanceMeta, Mesh};
use nalgebra::Matrix4;

const IDENTITY16: [f64; 16] = [
    1.0, 0.0, 0.0, 0.0, //
    0.0, 1.0, 0.0, 0.0, //
    0.0, 0.0, 1.0, 0.0, //
    0.0, 0.0, 0.0, 1.0, //
];

/// Full world transform `transform · local_transform` for an occurrence.
pub(super) fn compose_world(meta: &InstanceMeta) -> Matrix4<f64> {
    let t = Matrix4::from_row_slice(&meta.transform);
    let l = Matrix4::from_row_slice(meta.local_transform.as_ref().unwrap_or(&IDENTITY16));
    // Rigid tier: canonical->local transform, composed innermost. For occurrences
    // grouped by congruence (not bit-identity) this carries the recovered rotation
    // so the shared template reproduces this occurrence's baked geometry.
    let c = Matrix4::from_row_slice(meta.canonical_transform.as_ref().unwrap_or(&IDENTITY16));
    t * l * c
}

/// Flatten a column-major nalgebra matrix into a row-major `[f32; 16]`.
pub(super) fn mat4_to_row_major_f32(m: &Matrix4<f64>) -> [f32; 16] {
    let mut out = [0.0f32; 16];
    for r in 0..4 {
        for c in 0..4 {
            out[r * 4 + c] = m[(r, c)] as f32;
        }
    }
    out
}

/// One occurrence of a template geometry.
#[derive(Debug, Clone)]
pub struct InstanceOccurrence {
    /// Index of the original mesh in the input slice (carries entity id / colour).
    pub mesh_index: usize,
    /// Row-major mat4 mapping the template's baked world geometry onto this
    /// occurrence. The template occurrence's transform is identity.
    pub transform: [f32; 16],
}

/// A unique geometry shared by two or more occurrences.
#[derive(Debug, Clone)]
pub struct InstanceTemplate {
    /// Representation-identity key (RepresentationMap id for mapped items).
    pub rep_identity: u128,
    /// Index of the mesh whose geometry is the template to upload.
    pub template_index: usize,
    /// Every occurrence (including the template itself, with identity transform).
    pub occurrences: Vec<InstanceOccurrence>,
}

/// Result of collation: instanced templates + the meshes left to render flat.
#[derive(Debug, Clone, Default)]
pub struct Collated {
    /// Unique geometries with their per-instance transforms.
    pub templates: Vec<InstanceTemplate>,
    /// Indices of input meshes rendered without instancing (non-instanceable,
    /// singleton groups, or groups that failed the geometry-shape guard).
    pub flat_indices: Vec<usize>,
    /// Pose-only (#1623 don't-bake) occurrences that appear in NEITHER
    /// `templates` nor `flat_indices`: they carry no geometry of their own, so
    /// the flat path is not somewhere they can go, and their group had no
    /// invertible template placement to instance them against. Nothing else in
    /// this result records that they existed, which is exactly why the count is
    /// here — an occurrence going missing must not look like an occurrence that
    /// was never fed in. Zero on every ordinary model.
    pub dropped_placeholders: usize,
    /// Groups the #3666 reconstruction (or same-shape) check refused, so their
    /// materialized members sit in `flat_indices` instead of sharing a template.
    ///
    /// The refusal is not free where the caller has no flat path of its own:
    /// `encode_refs` emits every `flat_indices` entry as a ONE-INSTANCE template,
    /// so a refused group of N becomes N singleton templates in an IFNS shard —
    /// O(unique-geometry) per-frame draws, which is the orbit-FPS regression the
    /// WASM viewer's occurrence-count gate exists to prevent. A caller that HAS a
    /// flat path should route these members to it (the WASM batch partition
    /// does), and this count is how the case is observable at all.
    pub verification_rejections: usize,
}

impl Collated {
    /// Total number of unique geometries that would be uploaded (templates +
    /// flat meshes) — the figure that bounds browser ingestion.
    pub fn unique_geometry_count(&self) -> usize {
        self.templates.len() + self.flat_indices.len()
    }

    /// Total occurrences represented across all templates (excludes flat meshes).
    pub fn instanced_occurrence_count(&self) -> usize {
        self.templates.iter().map(|t| t.occurrences.len()).sum()
    }
}

/// A borrowed view of a mesh for collation/encoding — lets callers feed geometry
/// from any owner (geometry's `Mesh`, processing's `MeshData`) WITHOUT cloning the
/// vertex data (cloning 219k meshes' geometry risks the build-container OOM).
pub struct InstanceMeshRef<'a> {
    pub positions: &'a [f32],
    pub normals: &'a [f32],
    pub indices: &'a [u32],
    pub origin: [f64; 3],
    pub instance_meta: Option<&'a InstanceMeta>,
    /// Per-occurrence entity id (used only by the encoder).
    pub entity_id: u32,
    /// Per-occurrence RGBA (used only by the encoder).
    pub color: [f32; 4],
    /// The `IfcRepresentationItem` this occurrence's geometry was tessellated
    /// from (`MeshData::geometry_item_id`) — the host's drill-to-source link,
    /// used only by the encoder. `Option` like every other link in the chain
    /// (`RawInstanceOccurrence`, `InstanceRecord`, `DecodedInstance::item_id`), so
    /// no caller can pass a meaningful-looking `0`; the encoder collapses `None`
    /// to the wire's `0` once, where that sentinel is a wire fact.
    pub item_id: Option<u32>,
}

impl<'a> InstanceMeshRef<'a> {
    /// Build a view over a geometry `Mesh` (encoder id/colour default to 0).
    pub fn from_mesh(m: &'a Mesh) -> Self {
        InstanceMeshRef {
            positions: &m.positions,
            normals: &m.normals,
            indices: &m.indices,
            origin: m.origin,
            instance_meta: m.instance_meta.as_ref(),
            entity_id: 0,
            color: [0.0; 4],
            item_id: None,
        }
    }
}

/// Subtract the model RTC offset from a composed (pre-RTC) world transform's
/// translation column, giving the post-RTC placement that matches the post-RTC
/// per-mesh `origin` the renderer applies the relative transform to.
pub(super) fn to_post_rtc(mut m: Matrix4<f64>, rtc: [f64; 3]) -> Matrix4<f64> {
    m[(0, 3)] -= rtc[0];
    m[(1, 3)] -= rtc[1];
    m[(2, 3)] -= rtc[2];
    m
}


// The #1623 Phase 2 don't-bake finalize helpers (`compose_instance_world_row_major`,
// `instance_rel_row_major_f32`, `bake_source_at_world`) moved to `super::dont_bake`
// (kept re-exported below) — the module-size ratchet budget pushed them out once
// the per-member rigidity fix and its diagnostics landed here.
pub use super::dont_bake::{
    bake_source_at_world, compose_instance_world_row_major, instance_rel_row_major_f32,
};

/// `collate_refs` over geometry `Mesh` values (thin wrapper, no geometry clone).
pub fn collate_instances(meshes: &[Mesh], min_group: usize, rtc: [f64; 3]) -> Collated {
    let refs: Vec<InstanceMeshRef> = meshes.iter().map(InstanceMeshRef::from_mesh).collect();
    collate_refs(&refs, min_group, rtc)
}

// verify_recomposition moved to super::verify (kept as a re-export below) —
// the module-size ratchet budget pushed it out once #3666's inline pairing
// check landed here; it belongs next to that check's shared math anyway.
pub use super::verify::verify_recomposition;
