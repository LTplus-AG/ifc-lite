// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Mesh oracles over raw `positions` (xyz triples) / `indices` slices.
//!
//! Test code used to re-derive these per file with different vertex keying
//! and tolerances, so the same regression could pass one test and fail
//! another purely because of the oracle. The keying is now an explicit
//! argument ([`Key`]).

use std::collections::HashMap;

/// How vertices are identified when counting shared edges.
#[derive(Clone, Copy, Debug)]
pub enum Key {
    /// Exact `f32` bit patterns (no tolerance).
    Bits,
    /// Snap to a grid of the given pitch (world units).
    Grid(f64),
}

impl Key {
    fn of(self, p: [f32; 3]) -> [i64; 3] {
        match self {
            Key::Bits => p.map(|c| i64::from(c.to_bits())),
            Key::Grid(pitch) => p.map(|c| (f64::from(c) / pitch).round() as i64),
        }
    }
}

fn vertex(positions: &[f32], i: u32) -> [f32; 3] {
    let o = i as usize * 3;
    [positions[o], positions[o + 1], positions[o + 2]]
}

/// Axis-aligned bounds `(min, max)`; `([inf;3], [-inf;3])` when empty.
pub fn bbox(positions: &[f32]) -> ([f32; 3], [f32; 3]) {
    let mut min = [f32::INFINITY; 3];
    let mut max = [f32::NEG_INFINITY; 3];
    for p in positions.chunks_exact(3) {
        for a in 0..3 {
            min[a] = min[a].min(p[a]);
            max[a] = max[a].max(p[a]);
        }
    }
    (min, max)
}

/// Signed volume by the divergence theorem, accumulated in `f64` about the
/// bounding-box centre. Referencing the centre (not the world origin) keeps
/// the result translation-stable for open meshes and far-from-origin
/// operands. Positive for outward (CCW) winding.
pub fn signed_volume(positions: &[f32], indices: &[u32]) -> f64 {
    let (min, max) = bbox(positions);
    if min[0] > max[0] {
        return 0.0;
    }
    let c = [0, 1, 2].map(|a| (f64::from(min[a]) + f64::from(max[a])) * 0.5);
    let rel = |i: u32| {
        let p = vertex(positions, i);
        [0, 1, 2].map(|a| f64::from(p[a]) - c[a])
    };
    indices
        .chunks_exact(3)
        .map(|t| {
            let (a, b, d) = (rel(t[0]), rel(t[1]), rel(t[2]));
            let cross = [
                b[1] * d[2] - b[2] * d[1],
                b[2] * d[0] - b[0] * d[2],
                b[0] * d[1] - b[1] * d[0],
            ];
            (a[0] * cross[0] + a[1] * cross[1] + a[2] * cross[2]) / 6.0
        })
        .sum()
}

/// Number of undirected edges whose incidence count is not exactly 2
/// (boundary edges plus non-manifold edges). Zero for a closed 2-manifold.
pub fn open_edges(positions: &[f32], indices: &[u32], key: Key) -> usize {
    let mut incidence: HashMap<([i64; 3], [i64; 3]), u32> = HashMap::new();
    for t in indices.chunks_exact(3) {
        let k = [0, 1, 2].map(|i| key.of(vertex(positions, t[i])));
        for (a, b) in [(k[0], k[1]), (k[1], k[2]), (k[2], k[0])] {
            if a == b {
                continue;
            }
            let edge = if a <= b { (a, b) } else { (b, a) };
            *incidence.entry(edge).or_insert(0) += 1;
        }
    }
    incidence.values().filter(|&&n| n != 2).count()
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
    fn bbox_of_empty_is_inverted() {
        let (min, max) = bbox(&[]);
        assert!(min[0] > max[0]);
    }
}
