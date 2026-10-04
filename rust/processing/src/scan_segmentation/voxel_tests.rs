// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::*;
use crate::scan_segmentation::ScanSegmentationOptions;

fn grid(voxel: f64, max_voxels: u32) -> VoxelGrid {
    let options = ScanSegmentationOptions { voxel_size_metres: voxel, max_voxels, ..Default::default() };
    VoxelGrid::new(&options.validate().unwrap())
}

/// Deterministic scatter over a 2 m cube, negative coordinates included.
fn points(n: usize) -> Vec<f32> {
    let mut state = 12_345_u64;
    (0..n * 3)
        .map(|_| {
            state = state.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
            ((state >> 33) as f64 / (1_u64 << 31) as f64 * 2. - 1.) as f32
        })
        .collect()
}

fn snapshot(set: &VoxelSet) -> Vec<(Key, u32, [u64; 3])> {
    (0..set.len()).map(|i| (set.keys[i], set.counts[i], set.means[i].map(f64::to_bits))).collect()
}

#[test]
fn issue_6870_folding_into_coarser_voxels_equals_direct_voxelization() {
    let p = points(20_000);
    let mut budgeted = grid(0.03, 1_000);
    budgeted.add(&p).unwrap();
    assert!(budgeted.coarsenings >= 3, "20k scattered points need several doublings");
    let coarse_size = budgeted.size_metres();
    let folded = budgeted.finish();
    assert!(folded.len() <= 1_000);
    // Same lattice, voxelised directly at the coarse edge.
    let mut direct = grid(0.03, 8_000_000);
    direct.size_quanta = (coarse_size * QUANTA_PER_METRE) as i64;
    direct.add(&p).unwrap();
    assert_eq!(snapshot(&folded), snapshot(&direct.finish()));
}

#[test]
fn issue_6870_voxel_means_are_exact_averages() {
    let mut g = grid(0.5, 1_000);
    // Two points in voxel (0,0,0), one in voxel (-1,0,0).
    g.add(&[0.1, 0.2, 0.3, 0.3, 0.2, 0.1, -0.25, 0.25, 0.25]).unwrap();
    let set = g.finish();
    assert_eq!(set.keys, vec![[-1, 0, 0], [0, 0, 0]]);
    assert_eq!(set.counts, vec![1, 2]);
    for (got, want) in set.means[1].iter().zip([0.2, 0.2, 0.2]) {
        assert!((got - want).abs() < 2e-5, "{got} vs {want}");
    }
    assert!((set.means[0][0] + 0.25).abs() < 2e-5);
}

#[test]
fn issue_6870_neighbours_visit_the_occupied_ring_in_fixed_order() {
    let mut g = grid(1., 1_000);
    g.add(&[0.5, 0.5, 0.5, 1.5, 0.5, 0.5, -0.5, -0.5, -0.5, 2.5, 0.5, 0.5]).unwrap();
    let set = g.finish();
    let centre = set.keys.iter().position(|k| *k == [0, 0, 0]).unwrap() as u32;
    let mut seen = Vec::new();
    set.for_each_neighbor(centre, 1, |j| seen.push(set.keys[j as usize]));
    assert_eq!(seen, vec![[-1, -1, -1], [1, 0, 0]], "the voxel two away is outside one ring");
    seen.clear();
    set.for_each_neighbor(centre, 2, |j| seen.push(set.keys[j as usize]));
    assert_eq!(seen.len(), 3);
}
