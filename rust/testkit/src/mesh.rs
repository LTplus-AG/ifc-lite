// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Mesh oracles over raw `positions` (xyz triples) / `indices` slices.
//!
//! Test code used to re-derive these per file with different vertex keying
//! and tolerances, so the same regression could pass one test and fail
//! another purely because of the oracle. The keying is now an explicit
//! argument ([`Key`]).

use ifc_lite_geometry::mesh::Mesh;
use ifc_lite_geometry::mesh_check::{self, Degenerate, EdgeLedger, VertexKey};

/// How vertices are identified when counting shared edges.
#[derive(Clone, Copy, Debug)]
pub enum Key {
    /// Exact `f32` values, no tolerance. `-0.0` and `+0.0` are the SAME
    /// vertex (they compare equal as floats; keying on raw bits would split a
    /// shared corner and report phantom open edges). NaN positions with equal
    /// bits are equal to each other; callers wanting NaN rejected should
    /// check for it first.
    Bits,
    /// Snap to a grid of the given pitch (world units).
    Grid(f64),
}

impl Key {
    fn vertex_key(self) -> VertexKey {
        match self {
            Key::Bits => VertexKey::BitsZeroFolded,
            Key::Grid(pitch) => VertexKey::GridDiv(pitch),
        }
    }
}

/// Axis-aligned bounds `(min, max)`; `([inf;3], [-inf;3])` when empty.
///
/// NaN is explicit, never silently skipped (`f32::min` would drop it and hide
/// a corrupt mesh from the oracle): an axis holding any NaN coordinate reports
/// `NaN` for both its min and max, so a following comparison fails loudly.
pub fn bbox(positions: &[f32]) -> ([f32; 3], [f32; 3]) {
    let mut min = [f32::INFINITY; 3];
    let mut max = [f32::NEG_INFINITY; 3];
    let mut nan = [false; 3];
    for p in positions.chunks_exact(3) {
        for a in 0..3 {
            if p[a].is_nan() {
                nan[a] = true;
            }
            min[a] = min[a].min(p[a]);
            max[a] = max[a].max(p[a]);
        }
    }
    for a in 0..3 {
        if nan[a] {
            min[a] = f32::NAN;
            max[a] = f32::NAN;
        }
    }
    (min, max)
}

/// Signed volume by the divergence theorem, accumulated in `f64` about the
/// bounding-box centre ([`mesh_check::signed_volume`]). Referencing the centre
/// (not the world origin) keeps the result translation-stable for open meshes
/// and far-from-origin operands. Positive for outward (CCW) winding.
pub fn signed_volume(positions: &[f32], indices: &[u32]) -> f64 {
    let mut mesh = Mesh::new();
    mesh.positions = positions.to_vec();
    mesh.indices = indices.to_vec();
    mesh_check::signed_volume(&mesh)
}

/// Number of undirected edges whose incidence count is not exactly 2
/// (boundary edges plus non-manifold edges). Zero for a closed 2-manifold.
/// Zero-length edges (both ends on one key) are ignored.
pub fn open_edges(positions: &[f32], indices: &[u32], key: Key) -> usize {
    EdgeLedger::build_raw(positions, indices, key.vertex_key(), Degenerate::SkipEdge).undirected_defects()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Outward-wound axis-aligned box at `lo` with edge lengths `s`.
    fn cube(lo: [f32; 3], s: f32) -> (Vec<f32>, Vec<u32>) {
        let mut p = Vec::new();
        for i in 0..8u32 {
            p.extend([lo[0] + s * (i & 1) as f32, lo[1] + s * ((i >> 1) & 1) as f32, lo[2] + s * ((i >> 2) & 1) as f32]);
        }
        let quads: [[u32; 4]; 6] = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
        let idx = quads.iter().flat_map(|q| [q[0], q[1], q[2], q[0], q[2], q[3]]).collect();
        (p, idx)
    }

    #[test]
    fn unit_cube_is_closed_with_unit_volume() {
        let (p, i) = cube([0.0; 3], 1.0);
        assert!((signed_volume(&p, &i) - 1.0).abs() < 1e-12);
        assert_eq!(open_edges(&p, &i, Key::Bits), 0);
        assert_eq!(open_edges(&p, &i, Key::Grid(1e-4)), 0);
    }

    #[test]
    fn volume_is_translation_stable_far_from_the_origin() {
        let (p, i) = cube([10_000.0, -10_000.0, 5_000.0], 2.0);
        assert!((signed_volume(&p, &i) - 8.0).abs() < 1e-9);
    }

    #[test]
    fn dropping_a_triangle_opens_edges_and_flipping_negates_volume() {
        let (p, i) = cube([0.0; 3], 1.0);
        assert_eq!(open_edges(&p, &i[3..], Key::Bits), 3);
        let flipped: Vec<u32> = i.chunks_exact(3).flat_map(|t| [t[0], t[2], t[1]]).collect();
        assert!((signed_volume(&p, &flipped) + 1.0).abs() < 1e-12);
    }

    #[test]
    fn grid_key_welds_vertices_that_exact_bits_keep_apart() {
        let (mut p, i) = cube([0.0; 3], 1.0);
        // Duplicate vertex 0 as a hair-offset twin used by the first triangle only.
        p.extend([1e-7, 0.0, 0.0]);
        let mut split = i.clone();
        split[0] = 8;
        assert!(open_edges(&p, &split, Key::Bits) > 0);
        assert_eq!(open_edges(&p, &split, Key::Grid(1e-4)), 0);
    }

    #[test]
    fn negative_zero_is_the_same_vertex_as_positive_zero_under_bits() {
        // A triangle fan whose shared corner is written +0.0 in one triangle and
        // -0.0 in the other: closed as floats, "open" if keyed on raw bits.
        let p = [0.0f32, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, -0.0, -0.0, -0.0, 0.0, 1.0, 0.0, 1.0, 0.0, 0.0];
        // Two coincident triangles with opposite winding bound a closed sheet.
        let i = [0u32, 1, 2, 3, 5, 4];
        assert_eq!(open_edges(&p, &i, Key::Bits), 0);
        assert_eq!(open_edges(&p, &i, Key::Grid(1e-4)), 0);
    }

    #[test]
    fn bbox_reports_nan_instead_of_skipping_it() {
        let (min, max) = bbox(&[0.0, 1.0, 2.0, f32::NAN, 3.0, 4.0]);
        assert!(min[0].is_nan() && max[0].is_nan(), "NaN axis is NaN, not 0.0");
        assert_eq!((min[1], max[1]), (1.0, 3.0));
        assert_eq!((min[2], max[2]), (2.0, 4.0));
    }

    #[test]
    fn bbox_of_empty_is_inverted() {
        let (min, max) = bbox(&[]);
        assert!(min[0] > max[0]);
    }
}
