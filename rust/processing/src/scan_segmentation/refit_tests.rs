// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::*;
use crate::scan_segmentation::normals::estimate;
use crate::scan_segmentation::voxel::VoxelGrid;
use crate::scan_segmentation::ScanSegmentationOptions;

fn voxelise(points: &[[f64; 3]]) -> (VoxelSet, Params) {
    let params = ScanSegmentationOptions::default().validate().unwrap();
    let mut grid = VoxelGrid::new(&params);
    let flat: Vec<f32> = points.iter().flatten().map(|v| *v as f32).collect();
    grid.add(&flat).unwrap();
    (grid.finish(), params)
}

fn whole(voxels: &VoxelSet) -> Region {
    let members: Vec<u32> = (0..voxels.len() as u32).collect();
    let fit = refit(voxels, &members).unwrap();
    Region { voxels: members, normal: fit.normal, centroid: fit.centroid }
}

/// Grid of points on z = 0, 1.2 m square, 1 cm spacing.
fn floor() -> Vec<[f64; 3]> {
    (0..120).flat_map(|i| (0..120).map(move |j| [i as f64 * 0.01, j as f64 * 0.01, 0.])).collect()
}

#[test]
fn issue_6870_robust_refit_trims_a_stray_layer_and_keeps_the_plane() {
    let mut points = floor();
    // A clutter patch 4.5 cm above one corner, in the voxel layer above the
    // floor's: well outside the MAD band.
    points.extend((0..20).flat_map(|i| (0..20).map(move |j| [i as f64 * 0.01, j as f64 * 0.01, 0.045])));
    let (voxels, params) = voxelise(&points);
    let mut region = whole(&voxels);
    // Pull the starting plane off by the clutter, as growth would have.
    region.centroid[2] = 0.004;
    let mut labels = vec![0; voxels.len()];
    let trimmed = robust_refit(region, &voxels, &mut labels, &params).unwrap();
    assert!(trimmed.normal[2].abs() > 1. - 1e-9, "{:?}", trimmed.normal);
    assert!(trimmed.centroid[2].abs() < 1e-3, "plane refitted on the floor: {:?}", trimmed.centroid);
    let released = labels.iter().filter(|&&l| l == UNCLAIMED).count();
    assert!(released > 0 && released < voxels.len() / 4, "only the clutter voxels are released ({released})");
}

#[test]
fn issue_6870_bend_separates_a_column_strip_from_a_plane() {
    let (plane_voxels, params) = voxelise(&floor());
    let normals = estimate(&plane_voxels, params.rings, params.min_support);
    assert!(bend(&whole(&plane_voxels), &plane_voxels, &normals) < 0.1);
    // A 40 degree arc of a radius 0.3 m column, 2 m tall.
    let arc: Vec<[f64; 3]> = (0..80)
        .flat_map(|i| {
            let angle = (i as f64 / 79. - 0.5) * 40_f64.to_radians();
            (0..400).map(move |k| [0.3 * angle.cos(), 0.3 * angle.sin(), k as f64 * 0.005])
        })
        .collect();
    let (arc_voxels, _) = voxelise(&arc);
    let normals = estimate(&arc_voxels, params.rings, params.min_support);
    let measured = bend(&whole(&arc_voxels), &arc_voxels, &normals);
    assert!(measured > 2. && measured < 1. / 0.3 * 1.2, "about 1/r = 3.3 per metre: {measured}");
}
