// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Mesh content deduplication for instanced rendering.
//!
//! IFC files are extremely redundant at the geometry level — a typical building
//! has thousands of door, window, fastener, and column instances that all
//! tessellate to the same mesh. This module collapses identical [`QuantizedMesh`]
//! outputs into a single canonical mesh + a list of [`MeshInstance`] records,
//! mirroring the dedup-by-representation pattern used by IfcOpenShell's
//! `ifcviewer` to keep memory and draw-call counts tractable on large
//! federations.
//!
//! The hash is a **content** hash over the quantised vertex/index buffers and
//! the AABB. It does not look at the source IFC entity, so two structurally
//! distinct entities that happen to tessellate to identical bytes (after
//! quantisation) are correctly treated as one mesh — exactly what we want for
//! GPU upload.

use rustc_hash::{FxHashMap, FxHasher};
use std::hash::Hasher;

use crate::quantize::QuantizedMesh;

/// One placement of a deduplicated mesh in the scene.
///
/// Mirrors the per-instance record laid out in the WebGPU instance SSBO
/// (`mat4 transform | u32 expressId | u32 baseColor | u32 override | u32 flags`).
/// `transform` is column-major to match the GPU-side `mat4x4<f32>` layout.
#[derive(Debug, Clone, Copy)]
pub struct MeshInstance {
    /// IFC `expressId` of the placed entity (local to the model — federation
    /// offsetting happens at the JS boundary).
    pub express_id: u32,
    /// Column-major 4×4 model matrix.
    pub transform: [f32; 16],
    /// Packed RGBA8 base colour (`r | g << 8 | b << 16 | a << 24`).
    pub base_color_rgba8: u32,
    /// Packed RGBA8 colour override; `0` means "use `base_color_rgba8`".
    pub override_rgba8: u32,
    /// Bit-packed flags. Bit 0 = visible, bit 1 = selected, bit 2 = ghost,
    /// further bits reserved.
    pub flags: u32,
}

impl MeshInstance {
    /// Convenience constructor with sane defaults: visible, no override, no flags.
    pub fn new(express_id: u32, transform: [f32; 16], base_color_rgba8: u32) -> Self {
        Self {
            express_id,
            transform,
            base_color_rgba8,
            override_rgba8: 0,
            flags: 1, // bit 0 = visible
        }
    }
}

/// One canonical mesh and every instance pointing at it.
#[derive(Debug, Clone)]
pub struct DedupedMesh {
    /// Stable content hash; usable as a cache key across runs.
    pub hash: u64,
    /// The canonical quantised mesh.
    pub mesh: QuantizedMesh,
    /// All placements that share this mesh, in insertion order.
    pub instances: Vec<MeshInstance>,
}

/// A scene composed of unique meshes and the instances that reference them.
#[derive(Debug, Clone, Default)]
pub struct DedupedScene {
    pub meshes: Vec<DedupedMesh>,
}

impl DedupedScene {
    /// Number of unique meshes after dedup.
    #[inline]
    pub fn unique_mesh_count(&self) -> usize {
        self.meshes.len()
    }

    /// Total instances across all meshes.
    #[inline]
    pub fn total_instance_count(&self) -> usize {
        self.meshes.iter().map(|m| m.instances.len()).sum()
    }

    /// Ratio of total placements to unique meshes. Returns `1.0` for an empty
    /// scene so callers can format it without a special case.
    pub fn dedup_ratio(&self) -> f32 {
        let unique = self.unique_mesh_count();
        if unique == 0 {
            return 1.0;
        }
        self.total_instance_count() as f32 / unique as f32
    }

    /// Total bytes occupied by the **unique** vertex buffers (positions + normals).
    /// Useful for reporting "GPU memory after dedup" against the un-deduped total.
    pub fn total_quantized_vertex_bytes(&self) -> usize {
        self.meshes
            .iter()
            .map(|m| {
                m.mesh.positions_q.len() * std::mem::size_of::<u16>()
                    + m.mesh.normals_q.len() * std::mem::size_of::<i8>()
            })
            .sum()
    }

    /// Total bytes occupied by the **unique** index buffers.
    pub fn total_index_bytes(&self) -> usize {
        self.meshes
            .iter()
            .map(|m| m.mesh.indices.len() * std::mem::size_of::<u32>())
            .sum()
    }
}

/// Streaming builder. Push `(mesh, instance)` pairs in any order; identical
/// meshes are collapsed automatically.
#[derive(Debug, Default)]
pub struct DedupBuilder {
    by_hash: FxHashMap<u64, usize>,
    scene: DedupedScene,
}

impl DedupBuilder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Reserve capacity for an expected number of unique meshes. Order of
    /// magnitude is enough — dedup ratios on real models are 5–50×, so passing
    /// `total_elements / 10` is usually fine.
    pub fn with_capacity(unique: usize) -> Self {
        Self {
            by_hash: FxHashMap::with_capacity_and_hasher(unique, Default::default()),
            scene: DedupedScene {
                meshes: Vec::with_capacity(unique),
            },
        }
    }

    /// Push a mesh + instance. If the mesh's content hash matches a previously
    /// pushed mesh, the duplicate `mesh` argument is dropped and only the
    /// instance is appended. First-seen meshes preserve insertion order in the
    /// resulting [`DedupedScene`].
    pub fn push(&mut self, mesh: QuantizedMesh, instance: MeshInstance) {
        // Empty meshes still get instances — useful for elements that produce
        // no geometry but should remain selectable. They all share the empty
        // mesh slot.
        let hash = hash_quantized_mesh(&mesh);
        if let Some(&idx) = self.by_hash.get(&hash) {
            self.scene.meshes[idx].instances.push(instance);
            return;
        }
        let idx = self.scene.meshes.len();
        self.by_hash.insert(hash, idx);
        self.scene.meshes.push(DedupedMesh {
            hash,
            mesh,
            instances: vec![instance],
        });
    }

    /// Finalise into a [`DedupedScene`].
    pub fn finish(self) -> DedupedScene {
        self.scene
    }
}

/// Stable 64-bit content hash for a [`QuantizedMesh`].
///
/// Hashes the AABB bytes, the quantised position/normal buffers, and the index
/// buffer. Output is deterministic for a given input on a given target (FxHash
/// is platform-dependent only via pointer width, not architecture endianness in
/// practice; we operate on plain byte slices here).
pub fn hash_quantized_mesh(mesh: &QuantizedMesh) -> u64 {
    let mut h = FxHasher::default();

    // AABB: hash as raw little-endian-equivalent f32 bytes. We can't use
    // `to_ne_bytes()` directly via Hash because `f32` doesn't implement Hash;
    // hash the bit patterns instead — same precision, fully deterministic.
    for v in mesh.aabb_min.iter().chain(mesh.aabb_max.iter()) {
        h.write_u32(v.to_bits());
    }

    // Lengths so that two buffers with the same payload but different splits
    // can't collide. (E.g. positions=[a,b], normals=[c,d] vs positions=[a],
    // normals=[b,c,d] is impossible by construction, but cheap insurance.)
    h.write_usize(mesh.positions_q.len());
    h.write_usize(mesh.normals_q.len());
    h.write_usize(mesh.indices.len());

    // Bulk byte hashing. Writing as bytes makes the hash content-only and
    // independent of the underlying Vec capacity / allocation address.
    h.write(bytemuck_u16(&mesh.positions_q));
    h.write(bytemuck_i8(&mesh.normals_q));
    h.write(bytemuck_u32(&mesh.indices));

    h.finish()
}

#[inline]
fn bytemuck_u16(v: &[u16]) -> &[u8] {
    // SAFETY: u16 has no padding and any bit pattern is valid as bytes.
    // Length is exact: `v.len() * size_of::<u16>()`.
    unsafe { std::slice::from_raw_parts(v.as_ptr() as *const u8, std::mem::size_of_val(v)) }
}

#[inline]
fn bytemuck_i8(v: &[i8]) -> &[u8] {
    // SAFETY: i8 and u8 share layout; transmuting a slice is sound.
    unsafe { std::slice::from_raw_parts(v.as_ptr() as *const u8, v.len()) }
}

#[inline]
fn bytemuck_u32(v: &[u32]) -> &[u8] {
    // SAFETY: u32 has no padding; reinterpreting as bytes is sound.
    unsafe { std::slice::from_raw_parts(v.as_ptr() as *const u8, std::mem::size_of_val(v)) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mesh::Mesh;

    fn unit_cube_mesh() -> Mesh {
        let mut m = Mesh::new();
        m.positions = vec![
            0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0,
            1.0, 1.0, 1.0, 1.0, 0.0, 1.0, 1.0,
        ];
        m.normals = vec![0.0; 24];
        for chunk in m.normals.chunks_exact_mut(3) {
            chunk[2] = 1.0;
        }
        m.indices = vec![0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6];
        m
    }

    fn identity4() -> [f32; 16] {
        let mut m = [0.0; 16];
        m[0] = 1.0;
        m[5] = 1.0;
        m[10] = 1.0;
        m[15] = 1.0;
        m
    }

    fn translation4(tx: f32, ty: f32, tz: f32) -> [f32; 16] {
        let mut m = identity4();
        m[12] = tx;
        m[13] = ty;
        m[14] = tz;
        m
    }

    #[test]
    fn identical_meshes_hash_identically() {
        let q1 = QuantizedMesh::from_mesh(&unit_cube_mesh());
        let q2 = QuantizedMesh::from_mesh(&unit_cube_mesh());
        assert_eq!(hash_quantized_mesh(&q1), hash_quantized_mesh(&q2));
    }

    #[test]
    fn position_change_changes_hash() {
        let mut m = unit_cube_mesh();
        let q1 = QuantizedMesh::from_mesh(&m);
        m.positions[0] += 0.5;
        let q2 = QuantizedMesh::from_mesh(&m);
        assert_ne!(hash_quantized_mesh(&q1), hash_quantized_mesh(&q2));
    }

    #[test]
    fn normal_change_changes_hash() {
        let mut m = unit_cube_mesh();
        let q1 = QuantizedMesh::from_mesh(&m);
        m.normals[0] = -1.0;
        m.normals[1] = 0.0;
        m.normals[2] = 0.0;
        let q2 = QuantizedMesh::from_mesh(&m);
        assert_ne!(hash_quantized_mesh(&q1), hash_quantized_mesh(&q2));
    }

    #[test]
    fn index_change_changes_hash() {
        let mut m = unit_cube_mesh();
        let q1 = QuantizedMesh::from_mesh(&m);
        m.indices.push(0);
        m.indices.push(1);
        m.indices.push(2);
        let q2 = QuantizedMesh::from_mesh(&m);
        assert_ne!(hash_quantized_mesh(&q1), hash_quantized_mesh(&q2));
    }

    #[test]
    fn aabb_change_changes_hash() {
        // Two meshes with identical *normalised* positions but different AABBs
        // (e.g. a cube and the same cube translated) must hash differently —
        // their dequantised positions differ.
        let cube = unit_cube_mesh();
        let mut shifted = cube.clone();
        for chunk in shifted.positions.chunks_exact_mut(3) {
            chunk[0] += 10.0;
        }
        let q1 = QuantizedMesh::from_mesh(&cube);
        let q2 = QuantizedMesh::from_mesh(&shifted);
        // positions_q is identical (normalised), but aabb_min differs → hashes differ.
        assert_eq!(q1.positions_q, q2.positions_q);
        assert_ne!(hash_quantized_mesh(&q1), hash_quantized_mesh(&q2));
    }

    #[test]
    fn dedup_collapses_identical_meshes() {
        let mut b = DedupBuilder::new();
        let q = QuantizedMesh::from_mesh(&unit_cube_mesh());
        b.push(q.clone(), MeshInstance::new(1, identity4(), 0xff0000ff));
        b.push(q.clone(), MeshInstance::new(2, translation4(2.0, 0.0, 0.0), 0xff0000ff));
        b.push(q.clone(), MeshInstance::new(3, translation4(4.0, 0.0, 0.0), 0xff0000ff));
        let scene = b.finish();
        assert_eq!(scene.unique_mesh_count(), 1);
        assert_eq!(scene.total_instance_count(), 3);
        assert!((scene.dedup_ratio() - 3.0).abs() < 1e-6);
        assert_eq!(scene.meshes[0].instances.len(), 3);
        // Express IDs preserved in insertion order.
        let ids: Vec<u32> = scene.meshes[0]
            .instances
            .iter()
            .map(|i| i.express_id)
            .collect();
        assert_eq!(ids, vec![1, 2, 3]);
    }

    #[test]
    fn dedup_keeps_distinct_meshes_separate() {
        let mut a = unit_cube_mesh();
        let mut b_mesh = unit_cube_mesh();
        // Make `b_mesh` a different mesh by adding an extra triangle.
        b_mesh.indices.extend_from_slice(&[0, 1, 4]);
        let qa = QuantizedMesh::from_mesh(&a);
        let qb = QuantizedMesh::from_mesh(&b_mesh);

        let mut builder = DedupBuilder::new();
        builder.push(qa.clone(), MeshInstance::new(1, identity4(), 0));
        builder.push(qb.clone(), MeshInstance::new(2, identity4(), 0));
        builder.push(qa.clone(), MeshInstance::new(3, identity4(), 0));
        let scene = builder.finish();
        assert_eq!(scene.unique_mesh_count(), 2);
        assert_eq!(scene.total_instance_count(), 3);
        // First-seen ordering: `a` came first, `b` second.
        assert_eq!(scene.meshes[0].instances.len(), 2);
        assert_eq!(scene.meshes[1].instances.len(), 1);

        // Touch `a` so the unused-warning doesn't fire on builds without tests.
        a.indices.clear();
    }

    #[test]
    fn empty_scene_dedup_ratio_is_one() {
        let scene = DedupBuilder::new().finish();
        assert_eq!(scene.unique_mesh_count(), 0);
        assert_eq!(scene.total_instance_count(), 0);
        assert!((scene.dedup_ratio() - 1.0).abs() < 1e-6);
        assert_eq!(scene.total_quantized_vertex_bytes(), 0);
        assert_eq!(scene.total_index_bytes(), 0);
    }

    #[test]
    fn empty_meshes_collapse_into_one_slot() {
        // Elements that produce no geometry (e.g. proxies, annotations) all map
        // to the same empty mesh — this keeps them addressable for selection
        // without bloating the scene.
        let empty = QuantizedMesh::empty();
        let mut b = DedupBuilder::new();
        b.push(empty.clone(), MeshInstance::new(1, identity4(), 0));
        b.push(empty.clone(), MeshInstance::new(2, identity4(), 0));
        let scene = b.finish();
        assert_eq!(scene.unique_mesh_count(), 1);
        assert_eq!(scene.total_instance_count(), 2);
    }

    #[test]
    fn vertex_byte_accounting_matches_unique_meshes_only() {
        // 100 instances of the same cube must report bytes for ONE cube,
        // not 100. This is the whole point of dedup.
        let q = QuantizedMesh::from_mesh(&unit_cube_mesh());
        let single_bytes = q.positions_q.len() * 2 + q.normals_q.len();
        let single_idx_bytes = q.indices.len() * 4;

        let mut b = DedupBuilder::new();
        for i in 0..100 {
            b.push(
                q.clone(),
                MeshInstance::new(i, translation4(i as f32, 0.0, 0.0), 0),
            );
        }
        let scene = b.finish();
        assert_eq!(scene.total_quantized_vertex_bytes(), single_bytes);
        assert_eq!(scene.total_index_bytes(), single_idx_bytes);
        assert_eq!(scene.total_instance_count(), 100);
        assert!((scene.dedup_ratio() - 100.0).abs() < 1e-6);
    }

    #[test]
    fn instance_default_flags_mark_visible() {
        let inst = MeshInstance::new(42, identity4(), 0xffffffff);
        assert_eq!(inst.flags & 1, 1);
        assert_eq!(inst.override_rgba8, 0);
    }

    #[test]
    fn hash_is_deterministic_across_repeated_calls() {
        let q = QuantizedMesh::from_mesh(&unit_cube_mesh());
        let h1 = hash_quantized_mesh(&q);
        let h2 = hash_quantized_mesh(&q);
        let h3 = hash_quantized_mesh(&q);
        assert_eq!(h1, h2);
        assert_eq!(h2, h3);
    }
}
