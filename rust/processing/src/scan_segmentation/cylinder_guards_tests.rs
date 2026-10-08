// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::*;
use crate::scan_segmentation::voxel::VoxelGrid;
use crate::scan_segmentation::ScanSegmentationOptions;

/// Voxels over 150 degrees of a vertical r 0.3 m, 2 m surface around the z
/// axis, with the cylinder that fits them.
fn arc() -> (VoxelSet, Cylinder, Vec<u32>) {
    arc_of(150.)
}

fn arc_of(degrees: f64) -> (VoxelSet, Cylinder, Vec<u32>) {
    let params = ScanSegmentationOptions::default().validate().unwrap();
    let mut grid = VoxelGrid::new(&params);
    let points: Vec<f32> = (0..300)
        .flat_map(|i| {
            let a = (i as f64 / 299. * degrees).to_radians();
            (0..200).flat_map(move |k| [0.3 * a.cos(), 0.3 * a.sin(), k as f64 * 0.01].map(|v| v as f32))
        })
        .collect();
    grid.add(&points).unwrap();
    let voxels = grid.finish();
    let inliers = (0..voxels.len() as u32).collect();
    (voxels, Cylinder { point: [0.; 3], axis: [0., 0., 1.], radius: 0.3 }, inliers)
}

/// The radial direction of voxel `i`, turned by `tilt` radians about z.
fn rotated_radial(voxels: &VoxelSet, i: u32, tilt: f64) -> Vec3 {
    let m = voxels.means[i as usize];
    let a = m[1].atan2(m[0]) + tilt;
    [a.cos(), a.sin(), 0.]
}

#[test]
fn issue_6870_radial_normals_pass_the_facet_test() {
    let (voxels, cylinder, inliers) = arc();
    assert!(!looks_faceted(&cylinder, &inliers, &voxels, 1, &|i| Some(rotated_radial(&voxels, i, 0.))));
}

#[test]
fn issue_6870_normals_that_turn_but_point_off_radial_fail_the_facet_test() {
    // They turn exactly as fast as the position (turning ratio 1), so only the
    // radial deviation test can refuse them: the apartment's corner clutter
    // turned 0.74 but pointed 13.5 degrees off radial.
    let (voxels, cylinder, inliers) = arc();
    assert!(looks_faceted(&cylinder, &inliers, &voxels, 1, &|i| Some(rotated_radial(&voxels, i, 20_f64.to_radians()))));
}

#[test]
fn issue_6870_normals_that_do_not_turn_fail_the_facet_test() {
    // Constant normals pointing at the arc's middle: radial there, then
    // increasingly off, and never turning (one flat facet).
    let (voxels, cylinder, inliers) = arc();
    let middle = 75_f64.to_radians();
    assert!(looks_faceted(&cylinder, &inliers, &voxels, 1, &|_| Some([middle.cos(), middle.sin(), 0.])));
}

#[test]
fn issue_6870_nothing_measurable_is_not_evidence_of_facets() {
    let (voxels, cylinder, inliers) = arc();
    assert!(!looks_faceted(&cylinder, &inliers, &voxels, 1, &|_| None));
}

#[test]
fn issue_6870_normals_that_turn_too_slowly_fail_the_facet_test() {
    // Over a 40 degree arc, normals turning at 0.45 of the position rate stay
    // within about 6 degrees of radial, so only the 0.6 turning bar refuses
    // them (a polygonal pier seen across one corner).
    let (voxels, cylinder, inliers) = arc_of(40.);
    let middle = 20_f64.to_radians();
    let slow = |i: u32| {
        let m = voxels.means[i as usize];
        let a = middle + 0.45 * (m[1].atan2(m[0]) - middle);
        Some([a.cos(), a.sin(), 0.])
    };
    assert!(looks_faceted(&cylinder, &inliers, &voxels, 1, &slow));
}
