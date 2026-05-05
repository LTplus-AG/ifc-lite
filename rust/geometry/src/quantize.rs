// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Vertex quantization for compact GPU upload.
//!
//! Compresses [`Mesh`] vertex data from 24 B/vertex (`f32×3` pos + `f32×3` normal)
//! to 12 B/vertex while preserving sub-millimeter precision for typical IFC elements.
//!
//! # Layout (12 B/vertex)
//!
//! | offset | size | field      | format         | decode                                          |
//! |--------|------|------------|----------------|-------------------------------------------------|
//! | 0      | 8    | position_q | `unorm16x4`    | `mix(aabb_min, aabb_max, t)` per axis (w unused)|
//! | 8      | 4    | normal_q   | `snorm8x4`     | octahedral decode of (xy); zw unused            |
//!
//! Position quantization is **per-mesh**: each [`QuantizedMesh`] carries its own AABB,
//! so a 10 m wall mesh has ~0.15 mm precision, a 100 m site shell ~1.5 mm.
//!
//! # References
//! * Cigolle et al., 2014 — *A Survey of Efficient Representations for Independent Unit Vectors*

use crate::mesh::Mesh;

/// Quantized triangle mesh ready for GPU upload.
///
/// Vertex stride is 12 B (8 B position + 4 B normal). Indices are kept as `u32`
/// since IFC meshes routinely exceed 65535 vertices after merging.
#[derive(Debug, Clone)]
pub struct QuantizedMesh {
    /// Per-mesh AABB minimum corner used as quantization basis.
    pub aabb_min: [f32; 3],
    /// Per-mesh AABB maximum corner used as quantization basis.
    pub aabb_max: [f32; 3],
    /// Vertex positions: 4×u16 per vertex (`px, py, pz, _pad`). Length is `vertex_count * 4`.
    pub positions_q: Vec<u16>,
    /// Vertex normals: 4×i8 per vertex (`nx, ny, _pad, _pad`), octahedral-encoded.
    /// Length is `vertex_count * 4`.
    pub normals_q: Vec<i8>,
    /// Triangle indices.
    pub indices: Vec<u32>,
}

impl QuantizedMesh {
    /// Vertex count.
    #[inline]
    pub fn vertex_count(&self) -> usize {
        self.positions_q.len() / 4
    }

    /// Triangle count.
    #[inline]
    pub fn triangle_count(&self) -> usize {
        self.indices.len() / 3
    }

    /// True if this mesh has no vertices.
    #[inline]
    pub fn is_empty(&self) -> bool {
        self.positions_q.is_empty()
    }

    /// Build a quantized mesh from a float [`Mesh`].
    ///
    /// The AABB is computed exactly from the input positions. Per-axis ranges that are
    /// degenerate (single-point meshes, axis-aligned slabs) are clamped to a tiny
    /// non-zero range so that quantization avoids `NaN`; degenerate axes always
    /// dequantize back to their min value, which is the correct behaviour.
    pub fn from_mesh(mesh: &Mesh) -> Self {
        if mesh.is_empty() {
            return Self::empty();
        }

        let vertex_count = mesh.vertex_count();
        let (aabb_min, aabb_max) = compute_aabb(&mesh.positions);

        // Range guards. `f32::EPSILON` keeps the divide finite; the resulting `t` is
        // always 0 because numerator is also 0 on a degenerate axis, so the dequant
        // returns aabb_min — the only meaningful value.
        let range = [
            (aabb_max[0] - aabb_min[0]).max(f32::EPSILON),
            (aabb_max[1] - aabb_min[1]).max(f32::EPSILON),
            (aabb_max[2] - aabb_min[2]).max(f32::EPSILON),
        ];

        let mut positions_q = Vec::with_capacity(vertex_count * 4);
        for chunk in mesh.positions.chunks_exact(3) {
            for axis in 0..3 {
                let t = ((chunk[axis] - aabb_min[axis]) / range[axis]).clamp(0.0, 1.0);
                positions_q.push((t * 65535.0).round() as u16);
            }
            positions_q.push(0);
        }

        let normals_q = if mesh.normals.is_empty() {
            // Geometry without normals is rare but supported: emit zeros and let the
            // shader fall back to screen-space derivatives.
            vec![0i8; vertex_count * 4]
        } else if mesh.normals.len() != mesh.positions.len() {
            // Defensive: if the producer emitted a mismatched normal buffer, treat as
            // missing rather than panicking on a chunk boundary.
            vec![0i8; vertex_count * 4]
        } else {
            let mut out = Vec::with_capacity(vertex_count * 4);
            for chunk in mesh.normals.chunks_exact(3) {
                let n = normalize_or_zero([chunk[0], chunk[1], chunk[2]]);
                let [ex, ey] = oct_encode_snorm8(n);
                out.push(ex);
                out.push(ey);
                out.push(0);
                out.push(0);
            }
            out
        };

        Self {
            aabb_min,
            aabb_max,
            positions_q,
            normals_q,
            indices: mesh.indices.clone(),
        }
    }

    /// Empty quantized mesh (zero AABB, no vertices, no indices).
    pub fn empty() -> Self {
        Self {
            aabb_min: [0.0; 3],
            aabb_max: [0.0; 3],
            positions_q: Vec::new(),
            normals_q: Vec::new(),
            indices: Vec::new(),
        }
    }

    /// Dequantize one vertex's position back to f32 world space.
    ///
    /// Used by CPU-side raycasting and snap detection. Reproduces the GPU shader's
    /// `mix(aabb_min, aabb_max, t)` exactly.
    #[inline]
    pub fn dequant_position(&self, vertex_idx: usize) -> [f32; 3] {
        let base = vertex_idx * 4;
        let qx = self.positions_q[base] as f32 / 65535.0;
        let qy = self.positions_q[base + 1] as f32 / 65535.0;
        let qz = self.positions_q[base + 2] as f32 / 65535.0;
        [
            self.aabb_min[0] + (self.aabb_max[0] - self.aabb_min[0]) * qx,
            self.aabb_min[1] + (self.aabb_max[1] - self.aabb_min[1]) * qy,
            self.aabb_min[2] + (self.aabb_max[2] - self.aabb_min[2]) * qz,
        ]
    }

    /// Dequantize one vertex's normal to a unit f32 vector.
    #[inline]
    pub fn dequant_normal(&self, vertex_idx: usize) -> [f32; 3] {
        let base = vertex_idx * 4;
        oct_decode_snorm8([self.normals_q[base], self.normals_q[base + 1]])
    }

    /// Materialise a full f32 position buffer (`vertex_count * 3`) for callers that
    /// need an arena of unpacked floats — e.g. parquet export, BVH refit on legacy
    /// code paths. Prefer [`Self::dequant_position`] for one-off lookups.
    pub fn dequant_positions(&self) -> Vec<f32> {
        let n = self.vertex_count();
        let mut out = Vec::with_capacity(n * 3);
        for i in 0..n {
            let p = self.dequant_position(i);
            out.extend_from_slice(&p);
        }
        out
    }
}

#[inline]
fn compute_aabb(positions: &[f32]) -> ([f32; 3], [f32; 3]) {
    let mut min = [f32::INFINITY; 3];
    let mut max = [f32::NEG_INFINITY; 3];
    for chunk in positions.chunks_exact(3) {
        for axis in 0..3 {
            if chunk[axis] < min[axis] {
                min[axis] = chunk[axis];
            }
            if chunk[axis] > max[axis] {
                max[axis] = chunk[axis];
            }
        }
    }
    (min, max)
}

#[inline]
fn normalize_or_zero(v: [f32; 3]) -> [f32; 3] {
    let len_sq = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
    if len_sq < 1e-12 {
        return [0.0, 0.0, 0.0];
    }
    let inv = len_sq.sqrt().recip();
    [v[0] * inv, v[1] * inv, v[2] * inv]
}

/// Encode a unit vector as two `i8` octahedral coordinates.
///
/// Worst-case angular error on a uniform sphere is ~1.4°. Zero-length inputs encode
/// to `[0, 0]`, which round-trips back to `(0, 0, 1)` after decode.
pub fn oct_encode_snorm8(n: [f32; 3]) -> [i8; 2] {
    let l1 = n[0].abs() + n[1].abs() + n[2].abs();
    if l1 < 1e-10 {
        return [0, 0];
    }
    let inv = l1.recip();
    let nx = n[0] * inv;
    let ny = n[1] * inv;
    let (ex, ey) = if n[2] >= 0.0 {
        (nx, ny)
    } else {
        // Lower hemisphere: fold to outer square.
        let sign_x = if nx >= 0.0 { 1.0 } else { -1.0 };
        let sign_y = if ny >= 0.0 { 1.0 } else { -1.0 };
        ((1.0 - ny.abs()) * sign_x, (1.0 - nx.abs()) * sign_y)
    };
    [snorm8_quantize(ex), snorm8_quantize(ey)]
}

/// Decode two `i8` octahedral coordinates back to a unit vector.
pub fn oct_decode_snorm8(e: [i8; 2]) -> [f32; 3] {
    let ex = snorm8_dequantize(e[0]);
    let ey = snorm8_dequantize(e[1]);
    let mut nx = ex;
    let mut ny = ey;
    let nz = 1.0 - ex.abs() - ey.abs();
    if nz < 0.0 {
        let sign_x = if nx >= 0.0 { 1.0 } else { -1.0 };
        let sign_y = if ny >= 0.0 { 1.0 } else { -1.0 };
        let new_x = (1.0 - ny.abs()) * sign_x;
        let new_y = (1.0 - nx.abs()) * sign_y;
        nx = new_x;
        ny = new_y;
    }
    let len_sq = nx * nx + ny * ny + nz * nz;
    if len_sq < 1e-12 {
        return [0.0, 0.0, 1.0];
    }
    let inv = len_sq.sqrt().recip();
    [nx * inv, ny * inv, nz * inv]
}

#[inline]
fn snorm8_quantize(x: f32) -> i8 {
    (x.clamp(-1.0, 1.0) * 127.0).round() as i8
}

#[inline]
fn snorm8_dequantize(x: i8) -> f32 {
    // Mirrors the WebGPU `snorm8` rule: divide by 127, clamp to [-1, 1].
    (x as f32 / 127.0).clamp(-1.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dot(a: [f32; 3], b: [f32; 3]) -> f32 {
        a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
    }

    fn angle_deg(a: [f32; 3], b: [f32; 3]) -> f32 {
        dot(a, b).clamp(-1.0, 1.0).acos().to_degrees()
    }

    #[test]
    fn oct_round_trip_axis_directions() {
        // Cardinal axes must round-trip to within 1° (the ±Z poles are exact).
        let dirs = [
            [1.0, 0.0, 0.0],
            [-1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, -1.0, 0.0],
            [0.0, 0.0, 1.0],
            [0.0, 0.0, -1.0],
        ];
        for &n in &dirs {
            let decoded = oct_decode_snorm8(oct_encode_snorm8(n));
            let err = angle_deg(n, decoded);
            assert!(err < 1.0, "axis {:?} round-trip error {:.3}°", n, err);
        }
    }

    #[test]
    fn oct_round_trip_diagonals() {
        let inv_sqrt3 = 1.0_f32 / 3.0_f32.sqrt();
        let mut max_err: f32 = 0.0;
        for &sx in &[-1.0_f32, 1.0] {
            for &sy in &[-1.0_f32, 1.0] {
                for &sz in &[-1.0_f32, 1.0] {
                    let n = [sx * inv_sqrt3, sy * inv_sqrt3, sz * inv_sqrt3];
                    let decoded = oct_decode_snorm8(oct_encode_snorm8(n));
                    let err = angle_deg(n, decoded);
                    max_err = max_err.max(err);
                }
            }
        }
        assert!(max_err < 1.5, "diagonal max error {:.3}°", max_err);
    }

    #[test]
    fn oct_worst_case_sphere_error() {
        // Sample the sphere uniformly via Fibonacci spiral. Worst-case angular error
        // for snorm8 octahedral encoding is ~1.4°.
        let n = 10_000usize;
        let phi = std::f32::consts::PI * (3.0 - 5.0_f32.sqrt());
        let mut max_err: f32 = 0.0;
        for i in 0..n {
            let y = 1.0 - (i as f32 / (n - 1) as f32) * 2.0;
            let radius = (1.0 - y * y).max(0.0).sqrt();
            let theta = phi * i as f32;
            let v = [theta.cos() * radius, y, theta.sin() * radius];
            let decoded = oct_decode_snorm8(oct_encode_snorm8(v));
            let err = angle_deg(v, decoded);
            if err > max_err {
                max_err = err;
            }
        }
        assert!(max_err < 1.6, "worst-case sphere error {:.3}°", max_err);
    }

    #[test]
    fn oct_zero_input_safe() {
        let zero = oct_encode_snorm8([0.0, 0.0, 0.0]);
        assert_eq!(zero, [0, 0]);
        let decoded = oct_decode_snorm8(zero);
        // Decoded value is unit-length, no NaNs.
        let len_sq = dot(decoded, decoded);
        assert!((len_sq - 1.0).abs() < 1e-3);
    }

    #[test]
    fn from_mesh_empty() {
        let m = Mesh::new();
        let q = QuantizedMesh::from_mesh(&m);
        assert!(q.is_empty());
        assert_eq!(q.vertex_count(), 0);
        assert_eq!(q.triangle_count(), 0);
    }

    #[test]
    fn from_mesh_aabb_is_exact() {
        let mut m = Mesh::new();
        m.positions = vec![
            -2.0, 0.5, 1.0, //
            3.0, -1.0, 4.0, //
            0.0, 2.0, 0.0, //
        ];
        m.normals = vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0];
        m.indices = vec![0, 1, 2];
        let q = QuantizedMesh::from_mesh(&m);
        assert_eq!(q.aabb_min, [-2.0, -1.0, 0.0]);
        assert_eq!(q.aabb_max, [3.0, 2.0, 4.0]);
    }

    #[test]
    fn from_mesh_position_round_trip_within_quantization_step() {
        // 10 m wall mesh: per-axis range up to 10 m → step = 10 / 65535 ≈ 0.15 mm.
        let mut m = Mesh::new();
        let positions = vec![
            0.0, 0.0, 0.0, //
            10.0, 0.0, 0.0, //
            10.0, 3.0, 0.0, //
            0.0, 3.0, 0.0, //
            5.0, 1.5, 0.25,
        ];
        m.positions = positions.clone();
        m.normals = vec![0.0; positions.len()];
        for chunk in m.normals.chunks_exact_mut(3) {
            chunk[2] = 1.0;
        }
        m.indices = vec![0, 1, 2, 0, 2, 3];

        let q = QuantizedMesh::from_mesh(&m);
        let range_x = q.aabb_max[0] - q.aabb_min[0];
        let range_y = q.aabb_max[1] - q.aabb_min[1];
        let range_z = (q.aabb_max[2] - q.aabb_min[2]).max(f32::EPSILON);
        let step_x = range_x / 65535.0;
        let step_y = range_y / 65535.0;
        let step_z = range_z / 65535.0;
        let bound = step_x.max(step_y).max(step_z) * 1.5;

        for (i, original) in positions.chunks_exact(3).enumerate() {
            let decoded = q.dequant_position(i);
            for axis in 0..3 {
                let err = (decoded[axis] - original[axis]).abs();
                assert!(
                    err <= bound,
                    "vertex {i} axis {axis}: error {err} > bound {bound}"
                );
            }
        }
    }

    #[test]
    fn from_mesh_degenerate_axis_does_not_panic() {
        // Flat mesh in XY plane (Z range = 0).
        let mut m = Mesh::new();
        m.positions = vec![0.0, 0.0, 5.0, 1.0, 0.0, 5.0, 0.5, 1.0, 5.0];
        m.normals = vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0];
        m.indices = vec![0, 1, 2];
        let q = QuantizedMesh::from_mesh(&m);
        for i in 0..3 {
            let p = q.dequant_position(i);
            // Z must dequantize back to exactly 5.0 because all inputs are 5.0.
            assert!((p[2] - 5.0).abs() < 1e-3, "z = {} (expected 5.0)", p[2]);
        }
    }

    #[test]
    fn from_mesh_normal_round_trip() {
        let mut m = Mesh::new();
        m.positions = vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
        // Three different normals.
        let inv_sqrt3 = 1.0_f32 / 3.0_f32.sqrt();
        m.normals = vec![
            1.0,
            0.0,
            0.0,
            0.0,
            1.0,
            0.0,
            inv_sqrt3,
            inv_sqrt3,
            inv_sqrt3,
        ];
        m.indices = vec![0, 1, 2];
        let q = QuantizedMesh::from_mesh(&m);
        let n0 = q.dequant_normal(0);
        let n1 = q.dequant_normal(1);
        let n2 = q.dequant_normal(2);
        assert!(angle_deg([1.0, 0.0, 0.0], n0) < 1.5);
        assert!(angle_deg([0.0, 1.0, 0.0], n1) < 1.5);
        assert!(angle_deg([inv_sqrt3, inv_sqrt3, inv_sqrt3], n2) < 1.5);
    }

    #[test]
    fn indices_are_preserved_verbatim() {
        let mut m = Mesh::new();
        m.positions = vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0];
        m.normals = vec![0.0; 12];
        m.indices = vec![0, 1, 2, 1, 3, 2, 0, 2, 3];
        let q = QuantizedMesh::from_mesh(&m);
        assert_eq!(q.indices, m.indices);
        assert_eq!(q.triangle_count(), 3);
    }

    #[test]
    fn dequant_positions_matches_per_vertex() {
        let mut m = Mesh::new();
        m.positions = vec![-1.0, 2.0, 0.5, 4.0, -0.25, 7.0];
        m.normals = vec![0.0, 0.0, 1.0, 0.0, 0.0, 1.0];
        m.indices = vec![];
        let q = QuantizedMesh::from_mesh(&m);
        let bulk = q.dequant_positions();
        assert_eq!(bulk.len(), 6);
        let v0 = q.dequant_position(0);
        let v1 = q.dequant_position(1);
        assert_eq!(&bulk[0..3], &v0);
        assert_eq!(&bulk[3..6], &v1);
    }

    #[test]
    fn missing_normals_yield_zeroed_buffer() {
        let mut m = Mesh::new();
        m.positions = vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
        m.normals = vec![]; // missing
        m.indices = vec![0, 1, 2];
        let q = QuantizedMesh::from_mesh(&m);
        assert_eq!(q.normals_q.len(), q.vertex_count() * 4);
        assert!(q.normals_q.iter().all(|&b| b == 0));
    }

    #[test]
    fn mismatched_normal_length_does_not_panic() {
        let mut m = Mesh::new();
        m.positions = vec![0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
        m.normals = vec![1.0, 0.0, 0.0]; // only 1 normal for 3 vertices
        m.indices = vec![0, 1, 2];
        let q = QuantizedMesh::from_mesh(&m);
        assert_eq!(q.vertex_count(), 3);
        assert_eq!(q.normals_q.len(), 12);
    }
}
