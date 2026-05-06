// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Zero-copy GPU bundle for quantised + instanced rendering.
//!
//! Packs a [`DedupedScene`](ifc_lite_geometry::DedupedScene) into four
//! contiguous byte buffers laid out exactly as the WebGPU pipeline expects them:
//!
//! | Buffer        | Stride | Contents                                                  |
//! |---------------|--------|-----------------------------------------------------------|
//! | `vertex_data` | 12 B   | `[u16; 4]` quantised position + `[i8; 4]` oct normal      |
//! | `index_data`  | 4 B    | `u32` indices, **mesh-local** (use `baseVertex` per draw) |
//! | `mesh_table`  | 64 B   | `MeshGpu`: AABB + vertex/index offsets + instance range   |
//! | `instance_data` | 80 B | `Instance`: `mat4` + `expressId`, `baseColor`, override, flags |
//!
//! Instances are sorted by `mesh_id` so each mesh's instances form one
//! contiguous slice — ready for a single `drawIndexedIndirect` per mesh.
//!
//! The layout mirrors the planned `RenderPipeline` shader bindings; see the
//! migration plan in `docs/` for the full WGSL signatures.

use ifc_lite_geometry::{DedupedScene, MeshInstance, QuantizedMesh};
use wasm_bindgen::prelude::*;

/// Per-vertex byte stride. Position is 8 B (`unorm16x4`), normal is 4 B (`snorm8x4`).
pub const VERTEX_STRIDE: usize = 12;
/// Per-mesh record byte size in [`QuantizedScene::mesh_table`].
pub const MESH_RECORD_SIZE: usize = 64;
/// Per-instance record byte size in [`QuantizedScene::instance_data`].
pub const INSTANCE_RECORD_SIZE: usize = 80;

/// Packed scene ready for direct WebGPU upload.
///
/// All buffers live in WASM linear memory; JavaScript creates `Uint8Array` /
/// `Uint32Array` views over the pointers and calls `device.queue.writeBuffer`
/// directly — no intermediate copy.
#[wasm_bindgen]
pub struct QuantizedScene {
    vertex_data: Vec<u8>,
    index_data: Vec<u32>,
    mesh_table: Vec<u8>,
    instance_data: Vec<u8>,
    mesh_count: u32,
    instance_count: u32,
    total_vertex_count: u32,
    total_index_count: u32,
    /// Tracks the dedup ratio that produced this scene (informational).
    dedup_ratio: f32,
}

#[wasm_bindgen]
impl QuantizedScene {
    // ── vertex buffer ────────────────────────────────────────────────
    #[wasm_bindgen(getter, js_name = vertexDataPtr)]
    pub fn vertex_data_ptr(&self) -> *const u8 {
        self.vertex_data.as_ptr()
    }

    #[wasm_bindgen(getter, js_name = vertexDataByteLength)]
    pub fn vertex_data_byte_length(&self) -> usize {
        self.vertex_data.len()
    }

    #[wasm_bindgen(getter, js_name = totalVertexCount)]
    pub fn total_vertex_count(&self) -> u32 {
        self.total_vertex_count
    }

    // ── index buffer ─────────────────────────────────────────────────
    #[wasm_bindgen(getter, js_name = indexDataPtr)]
    pub fn index_data_ptr(&self) -> *const u32 {
        self.index_data.as_ptr()
    }

    #[wasm_bindgen(getter, js_name = indexDataLen)]
    pub fn index_data_len(&self) -> usize {
        self.index_data.len()
    }

    #[wasm_bindgen(getter, js_name = indexDataByteLength)]
    pub fn index_data_byte_length(&self) -> usize {
        self.index_data.len() * std::mem::size_of::<u32>()
    }

    #[wasm_bindgen(getter, js_name = totalIndexCount)]
    pub fn total_index_count(&self) -> u32 {
        self.total_index_count
    }

    // ── mesh table ───────────────────────────────────────────────────
    #[wasm_bindgen(getter, js_name = meshTablePtr)]
    pub fn mesh_table_ptr(&self) -> *const u8 {
        self.mesh_table.as_ptr()
    }

    #[wasm_bindgen(getter, js_name = meshTableByteLength)]
    pub fn mesh_table_byte_length(&self) -> usize {
        self.mesh_table.len()
    }

    #[wasm_bindgen(getter, js_name = meshCount)]
    pub fn mesh_count(&self) -> u32 {
        self.mesh_count
    }

    // ── instance buffer ──────────────────────────────────────────────
    #[wasm_bindgen(getter, js_name = instanceDataPtr)]
    pub fn instance_data_ptr(&self) -> *const u8 {
        self.instance_data.as_ptr()
    }

    #[wasm_bindgen(getter, js_name = instanceDataByteLength)]
    pub fn instance_data_byte_length(&self) -> usize {
        self.instance_data.len()
    }

    #[wasm_bindgen(getter, js_name = instanceCount)]
    pub fn instance_count(&self) -> u32 {
        self.instance_count
    }

    // ── stats ────────────────────────────────────────────────────────
    #[wasm_bindgen(getter, js_name = dedupRatio)]
    pub fn dedup_ratio(&self) -> f32 {
        self.dedup_ratio
    }

    /// Layout constants exposed so the JS side can match offsets without hard-coding.
    #[wasm_bindgen(getter, js_name = vertexStride)]
    pub fn vertex_stride() -> u32 {
        VERTEX_STRIDE as u32
    }

    #[wasm_bindgen(getter, js_name = meshRecordSize)]
    pub fn mesh_record_size() -> u32 {
        MESH_RECORD_SIZE as u32
    }

    #[wasm_bindgen(getter, js_name = instanceRecordSize)]
    pub fn instance_record_size() -> u32 {
        INSTANCE_RECORD_SIZE as u32
    }
}

impl QuantizedScene {
    /// Pack a [`DedupedScene`] into the GPU-ready byte buffers.
    ///
    /// `mesh_table` and `instance_data` are written in mesh insertion order; each
    /// mesh's instances form one contiguous slice in `instance_data` so the
    /// renderer can issue one `drawIndexedIndirect` per mesh with no resorting.
    pub fn from_deduped(scene: &DedupedScene) -> Self {
        let mesh_count = scene.unique_mesh_count();
        let instance_count = scene.total_instance_count();
        let dedup_ratio = scene.dedup_ratio();

        let total_vertex_count: usize = scene.meshes.iter().map(|m| m.mesh.vertex_count()).sum();
        let total_index_count: usize = scene.meshes.iter().map(|m| m.mesh.indices.len()).sum();

        let mut vertex_data = Vec::with_capacity(total_vertex_count * VERTEX_STRIDE);
        let mut index_data = Vec::with_capacity(total_index_count);
        let mut mesh_table = Vec::with_capacity(mesh_count * MESH_RECORD_SIZE);
        let mut instance_data = Vec::with_capacity(instance_count * INSTANCE_RECORD_SIZE);

        let mut vertex_offset: u32 = 0;
        let mut index_offset: u32 = 0;
        let mut first_instance: u32 = 0;

        for deduped in &scene.meshes {
            let m = &deduped.mesh;
            let vc = m.vertex_count() as u32;
            let ic = m.indices.len() as u32;
            let inst_count = deduped.instances.len() as u32;

            append_interleaved_vertices(&mut vertex_data, m);
            // Indices stay mesh-local; the renderer applies `baseVertex` on draw.
            index_data.extend_from_slice(&m.indices);

            append_mesh_record(
                &mut mesh_table,
                m,
                vertex_offset,
                vc,
                index_offset,
                ic,
                first_instance,
                inst_count,
            );

            for inst in &deduped.instances {
                append_instance_record(&mut instance_data, inst);
            }

            vertex_offset += vc;
            index_offset += ic;
            first_instance += inst_count;
        }

        Self {
            vertex_data,
            index_data,
            mesh_table,
            instance_data,
            mesh_count: mesh_count as u32,
            instance_count: instance_count as u32,
            total_vertex_count: total_vertex_count as u32,
            total_index_count: total_index_count as u32,
            dedup_ratio,
        }
    }

    // Test-only accessors so unit tests can verify packed layout without going
    // through wasm-bindgen.
    #[cfg(test)]
    pub(crate) fn mesh_table_slice(&self) -> &[u8] {
        &self.mesh_table
    }
    #[cfg(test)]
    pub(crate) fn instance_data_slice(&self) -> &[u8] {
        &self.instance_data
    }
}

fn append_interleaved_vertices(out: &mut Vec<u8>, mesh: &QuantizedMesh) {
    let vc = mesh.vertex_count();
    out.reserve(vc * VERTEX_STRIDE);
    for v in 0..vc {
        let pos_base = v * 4;
        for i in 0..4 {
            out.extend_from_slice(&mesh.positions_q[pos_base + i].to_le_bytes());
        }
        // i8 → u8 reinterpret preserves the bit pattern, which is what `snorm8x4`
        // expects on the GPU side.
        for i in 0..4 {
            out.push(mesh.normals_q[pos_base + i] as u8);
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn append_mesh_record(
    out: &mut Vec<u8>,
    mesh: &QuantizedMesh,
    vertex_offset: u32,
    vertex_count: u32,
    index_offset: u32,
    index_count: u32,
    first_instance: u32,
    instance_count: u32,
) {
    let mut buf = [0u8; MESH_RECORD_SIZE];
    let mut cur = 0;

    // aabb_min: vec4<f32> (w pad = 0)
    for v in mesh.aabb_min.iter().chain(std::iter::once(&0.0_f32)) {
        buf[cur..cur + 4].copy_from_slice(&v.to_le_bytes());
        cur += 4;
    }
    // aabb_max: vec4<f32>
    for v in mesh.aabb_max.iter().chain(std::iter::once(&0.0_f32)) {
        buf[cur..cur + 4].copy_from_slice(&v.to_le_bytes());
        cur += 4;
    }
    // vertex_offset, vertex_count, index_offset, index_count
    for v in [vertex_offset, vertex_count, index_offset, index_count] {
        buf[cur..cur + 4].copy_from_slice(&v.to_le_bytes());
        cur += 4;
    }
    // first_instance, instance_count, _pad×2
    for v in [first_instance, instance_count, 0u32, 0u32] {
        buf[cur..cur + 4].copy_from_slice(&v.to_le_bytes());
        cur += 4;
    }
    debug_assert_eq!(cur, MESH_RECORD_SIZE);
    out.extend_from_slice(&buf);
}

fn append_instance_record(out: &mut Vec<u8>, inst: &MeshInstance) {
    let mut buf = [0u8; INSTANCE_RECORD_SIZE];
    let mut cur = 0;

    for v in &inst.transform {
        buf[cur..cur + 4].copy_from_slice(&v.to_le_bytes());
        cur += 4;
    }
    for v in [
        inst.express_id,
        inst.base_color_rgba8,
        inst.override_rgba8,
        inst.flags,
    ] {
        buf[cur..cur + 4].copy_from_slice(&v.to_le_bytes());
        cur += 4;
    }
    debug_assert_eq!(cur, INSTANCE_RECORD_SIZE);
    out.extend_from_slice(&buf);
}

#[cfg(test)]
mod tests {
    use super::*;
    use ifc_lite_geometry::{DedupBuilder, Mesh, QuantizedMesh};

    fn unit_quad() -> Mesh {
        let mut m = Mesh::new();
        m.positions = vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 0.0, 0.0, 1.0, 0.0];
        m.normals = vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0];
        m.indices = vec![0, 1, 2, 0, 2, 3];
        m
    }

    fn identity() -> [f32; 16] {
        let mut t = [0.0; 16];
        t[0] = 1.0;
        t[5] = 1.0;
        t[10] = 1.0;
        t[15] = 1.0;
        t
    }

    fn translation(tx: f32) -> [f32; 16] {
        let mut t = identity();
        t[12] = tx;
        t
    }

    #[test]
    fn empty_scene_packs_to_empty_buffers() {
        let scene = DedupBuilder::new().finish();
        let q = QuantizedScene::from_deduped(&scene);
        assert_eq!(q.mesh_count(), 0);
        assert_eq!(q.instance_count(), 0);
        assert_eq!(q.total_vertex_count(), 0);
        assert_eq!(q.total_index_count(), 0);
        assert_eq!(q.vertex_data_byte_length(), 0);
        assert_eq!(q.index_data_byte_length(), 0);
        assert_eq!(q.mesh_table_byte_length(), 0);
        assert_eq!(q.instance_data_byte_length(), 0);
    }

    #[test]
    fn vertex_buffer_stride_is_12_bytes() {
        let q = QuantizedMesh::from_mesh(&unit_quad());
        let mut b = DedupBuilder::new();
        b.push(q, MeshInstance::new(1, identity(), 0xff0000ff));
        let scene = b.finish();
        let bundle = QuantizedScene::from_deduped(&scene);
        assert_eq!(bundle.total_vertex_count(), 4);
        assert_eq!(bundle.vertex_data_byte_length(), 4 * VERTEX_STRIDE);
    }

    #[test]
    fn mesh_table_record_size_is_64_bytes() {
        let q = QuantizedMesh::from_mesh(&unit_quad());
        let mut b = DedupBuilder::new();
        b.push(q, MeshInstance::new(1, identity(), 0));
        let scene = b.finish();
        let bundle = QuantizedScene::from_deduped(&scene);
        assert_eq!(bundle.mesh_count(), 1);
        assert_eq!(bundle.mesh_table_byte_length(), MESH_RECORD_SIZE);
    }

    #[test]
    fn instance_record_size_is_80_bytes() {
        let q = QuantizedMesh::from_mesh(&unit_quad());
        let mut b = DedupBuilder::new();
        b.push(q.clone(), MeshInstance::new(1, identity(), 0));
        b.push(q, MeshInstance::new(2, translation(2.0), 0));
        let scene = b.finish();
        let bundle = QuantizedScene::from_deduped(&scene);
        assert_eq!(bundle.instance_count(), 2);
        assert_eq!(bundle.instance_data_byte_length(), 2 * INSTANCE_RECORD_SIZE);
    }

    #[test]
    fn instances_are_grouped_per_mesh_in_offset_order() {
        // Two distinct meshes, three instances total: [meshA, meshB, meshA].
        // After packing the instance buffer must be [A0, A1, B0] (mesh-major),
        // and mesh table records must reference firstInstance correctly.
        let mut a = unit_quad();
        let mut b_mesh = unit_quad();
        b_mesh.indices.extend_from_slice(&[0, 1, 2]); // make distinct
        let qa = QuantizedMesh::from_mesh(&a);
        let qb = QuantizedMesh::from_mesh(&b_mesh);

        let mut builder = DedupBuilder::new();
        builder.push(qa.clone(), MeshInstance::new(10, identity(), 0));
        builder.push(qb.clone(), MeshInstance::new(20, identity(), 0));
        builder.push(qa.clone(), MeshInstance::new(11, translation(5.0), 0));
        let scene = builder.finish();
        let bundle = QuantizedScene::from_deduped(&scene);

        assert_eq!(bundle.mesh_count(), 2);
        assert_eq!(bundle.instance_count(), 3);

        // First mesh record: firstInstance = 0, instanceCount = 2
        let table = bundle.mesh_table_slice();
        let first_inst_a = read_u32_le(table, 32 + 16); // offset of first_instance in record 0
        let inst_count_a = read_u32_le(table, 32 + 20);
        assert_eq!(first_inst_a, 0);
        assert_eq!(inst_count_a, 2);

        // Second mesh record: firstInstance = 2, instanceCount = 1
        let first_inst_b = read_u32_le(table, MESH_RECORD_SIZE + 32 + 16);
        let inst_count_b = read_u32_le(table, MESH_RECORD_SIZE + 32 + 20);
        assert_eq!(first_inst_b, 2);
        assert_eq!(inst_count_b, 1);

        // Instance buffer: express IDs in order should be 10, 11, 20.
        let inst = bundle.instance_data_slice();
        assert_eq!(read_u32_le(inst, 64), 10);
        assert_eq!(read_u32_le(inst, INSTANCE_RECORD_SIZE + 64), 11);
        assert_eq!(read_u32_le(inst, 2 * INSTANCE_RECORD_SIZE + 64), 20);

        a.indices.clear();
    }

    #[test]
    fn vertex_offsets_account_for_prior_meshes() {
        let mut q1 = unit_quad();
        let mut q2 = unit_quad();
        q2.positions.push(2.0);
        q2.positions.push(2.0);
        q2.positions.push(0.0);
        q2.normals.push(0.0);
        q2.normals.push(0.0);
        q2.normals.push(1.0);
        q2.indices.push(0); // make distinct shape so dedup keeps both

        let mut b = DedupBuilder::new();
        b.push(QuantizedMesh::from_mesh(&q1), MeshInstance::new(1, identity(), 0));
        b.push(QuantizedMesh::from_mesh(&q2), MeshInstance::new(2, identity(), 0));
        let scene = b.finish();
        let bundle = QuantizedScene::from_deduped(&scene);

        let table = bundle.mesh_table_slice();
        // mesh 0: vertex_offset = 0, vertex_count = 4
        assert_eq!(read_u32_le(table, 32), 0);
        assert_eq!(read_u32_le(table, 36), 4);
        // mesh 1: vertex_offset = 4, vertex_count = 5
        assert_eq!(read_u32_le(table, MESH_RECORD_SIZE + 32), 4);
        assert_eq!(read_u32_le(table, MESH_RECORD_SIZE + 36), 5);
    }

    #[test]
    fn aabb_in_mesh_record_matches_quantized_mesh() {
        let mut m = Mesh::new();
        m.positions = vec![-1.0, 0.0, 0.5, 2.0, 3.0, 4.5];
        m.normals = vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0];
        m.indices = vec![];
        let q = QuantizedMesh::from_mesh(&m);

        let mut b = DedupBuilder::new();
        b.push(q.clone(), MeshInstance::new(1, identity(), 0));
        let bundle = QuantizedScene::from_deduped(&b.finish());

        let table = bundle.mesh_table_slice();
        for (i, &expected) in q.aabb_min.iter().enumerate() {
            let got = f32::from_le_bytes(table[i * 4..(i + 1) * 4].try_into().unwrap());
            assert!((got - expected).abs() < 1e-6, "aabb_min[{i}] = {got} vs {expected}");
        }
        for (i, &expected) in q.aabb_max.iter().enumerate() {
            let got = f32::from_le_bytes(table[16 + i * 4..16 + (i + 1) * 4].try_into().unwrap());
            assert!((got - expected).abs() < 1e-6, "aabb_max[{i}] = {got} vs {expected}");
        }
    }

    #[test]
    fn instance_payload_round_trips_express_id_and_color() {
        let q = QuantizedMesh::from_mesh(&unit_quad());
        let mut b = DedupBuilder::new();
        let mut inst = MeshInstance::new(0xCAFEBABE, translation(7.5), 0x11223344);
        inst.override_rgba8 = 0x55667788;
        inst.flags = 0b1011;
        b.push(q, inst);
        let bundle = QuantizedScene::from_deduped(&b.finish());

        let buf = bundle.instance_data_slice();
        // Transform tx at column 3 row 0 is at byte offset 12*4 = 48.
        let tx = f32::from_le_bytes(buf[48..52].try_into().unwrap());
        assert!((tx - 7.5).abs() < 1e-6);
        assert_eq!(read_u32_le(buf, 64), 0xCAFEBABE);
        assert_eq!(read_u32_le(buf, 68), 0x11223344);
        assert_eq!(read_u32_le(buf, 72), 0x55667788);
        assert_eq!(read_u32_le(buf, 76), 0b1011);
    }

    #[test]
    fn dedup_ratio_propagates_to_bundle() {
        let q = QuantizedMesh::from_mesh(&unit_quad());
        let mut b = DedupBuilder::new();
        for i in 0..5 {
            b.push(q.clone(), MeshInstance::new(i, translation(i as f32), 0));
        }
        let bundle = QuantizedScene::from_deduped(&b.finish());
        assert_eq!(bundle.mesh_count(), 1);
        assert_eq!(bundle.instance_count(), 5);
        assert!((bundle.dedup_ratio() - 5.0).abs() < 1e-6);
    }

    fn read_u32_le(buf: &[u8], offset: usize) -> u32 {
        u32::from_le_bytes(buf[offset..offset + 4].try_into().unwrap())
    }
}
