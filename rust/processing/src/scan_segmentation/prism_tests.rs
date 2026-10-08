// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::*;
use crate::scan_segmentation::grow::refit;
use crate::scan_segmentation::ring;
use crate::scan_segmentation::voxel::VoxelGrid;
use crate::scan_segmentation::ScanSegmentationOptions;

const CENTRE: P2 = [1.3, 0.7];
const APOTHEM: f64 = 0.45;

/// Vertical faces tangent to a circle of `APOTHEM` about `CENTRE` (plus
/// `push[i]` outward) at outward normal angles `angles` (ascending), each
/// running between its neighbours' crossings; an end face runs as far past
/// its tangent point as to its one crossing, plus `extend[i]`.
fn tangent_faces(angles: &[f64], push: &[f64], extend: &[f64]) -> Vec<(P2, P2)> {
    let normal = |a: f64| [a.cos(), a.sin()];
    let line = |i: usize| (normal(angles[i]), APOTHEM + push[i]);
    let cross = |i: usize, j: usize| {
        let ((a, p), (b, q)) = (line(i), line(j));
        let det = a[0] * b[1] - a[1] * b[0];
        [CENTRE[0] + (p * b[1] - q * a[1]) / det, CENTRE[1] + (a[0] * q - b[0] * p) / det]
    };
    let k = angles.len();
    let tangent = |i: usize| {
        let (n, d) = line(i);
        [CENTRE[0] + d * n[0], CENTRE[1] + d * n[1]]
    };
    let beyond = |i: usize, corner: P2| {
        let t = tangent(i);
        let (dx, dy) = (t[0] - corner[0], t[1] - corner[1]);
        let length = dx.hypot(dy);
        let reach = 1. + extend[i] / length;
        [corner[0] + reach * 2. * dx, corner[1] + reach * 2. * dy]
    };
    (0..k)
        .map(|i| {
            let start = if i == 0 { beyond(0, cross(0, 1)) } else { cross(i - 1, i) };
            let end = if i + 1 == k { beyond(k - 1, cross(k - 2, k - 1)) } else { cross(i, i + 1) };
            (start, end)
        })
        .collect()
}

/// Voxelised faces (1 cm samples, 0..2.7 m, no noise), one plane region per
/// face (its voxels nearest it), and the rings among them.
fn rings_of(faces: &[(P2, P2)]) -> (VoxelSet, Vec<Region>, Params, Plan, Vec<Ring>) {
    let params = ScanSegmentationOptions::default().validate().unwrap();
    let mut grid = VoxelGrid::new(&params);
    let mut points = Vec::new();
    for (a, b) in faces {
        let n = ((b[0] - a[0]).hypot(b[1] - a[1]) / 0.01) as usize;
        for i in 0..=n {
            let s = i as f64 / n as f64;
            for z in 0..=135 {
                points.extend([a[0] + s * (b[0] - a[0]), a[1] + s * (b[1] - a[1]), z as f64 * 0.02].map(|v| v as f32));
            }
        }
    }
    grid.add(&points).unwrap();
    let voxels = grid.finish();
    let distance = |p: Vec3, (a, b): &(P2, P2)| {
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let length = dx.hypot(dy);
        let t = (((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length).clamp(0., length);
        (p[0] - a[0] - t * dx / length).hypot(p[1] - a[1] - t * dy / length)
    };
    let mut members = vec![Vec::new(); faces.len()];
    for (i, &p) in voxels.means.iter().enumerate() {
        let nearest = (0..faces.len()).min_by(|&x, &y| distance(p, &faces[x]).total_cmp(&distance(p, &faces[y]))).unwrap();
        members[nearest].push(i as u32);
    }
    let regions: Vec<Region> = members
        .into_iter()
        .map(|m| {
            let fit = refit(&voxels, &m).unwrap();
            Region { voxels: m, normal: fit.normal, centroid: fit.centroid }
        })
        .collect();
    let plan = Plan::new(params.up);
    let rings = ring::find(&regions, &voxels, &params, &plan);
    (voxels, regions, params, plan, rings)
}

/// The faceted column the faces make, if any (None also when they are not one ring).
fn faceted(faces: &[(P2, P2)]) -> Option<Found> {
    let (voxels, regions, params, plan, rings) = rings_of(faces);
    let [ring] = rings.as_slice() else { return None };
    (ring.faces.len() == faces.len()).then(|| prism(ring, &regions, &voxels, &params, &plan)).flatten()
}

fn octagon(steps: &[f64]) -> Vec<f64> {
    steps.iter().map(|k| 0.2 + k * std::f64::consts::FRAC_PI_4).collect()
}

#[test]
fn issue_6893_half_an_octagon_is_an_eight_sided_column() {
    let angles = octagon(&[0., 1., 2., 3.]);
    let column = faceted(&tangent_faces(&angles, &[0.; 4], &[0.; 4])).expect("faceted");
    let facets = column.out.faceted.expect("facets");
    assert_eq!(facets.faces, 8);
    assert!((facets.apothem - APOTHEM).abs() < 0.005, "{facets:?}");
    assert!((column.out.radius - APOTHEM / (PI / 8.).cos()).abs() < 0.005, "{}", column.out.radius);
    let off = column.out.axis_start[0] - CENTRE[0];
    assert!(off.abs() < 0.005 && (column.out.axis_start[1] - CENTRE[1]).abs() < 0.005);
}

#[test]
fn issue_6893_three_faces_of_an_octagon_turn_too_little() {
    // 90 degrees in all: a 135 degree bay window from outside, or a pier.
    let angles = octagon(&[0., 1., 2.]);
    assert!(faceted(&tangent_faces(&angles, &[0.; 3], &[0.; 3])).is_none());
    // Four turn 135 degrees: a column.
    let angles = octagon(&[0., 1., 2., 3.]);
    assert!(faceted(&tangent_faces(&angles, &[0.; 4], &[0.; 4])).is_some());
}

#[test]
fn issue_6893_irregular_turns_are_not_a_regular_polygon() {
    // Steps of 45, 30, 45 and 45 degrees, every face tangent to one circle.
    let degrees: [f64; 5] = [0., 45., 75., 120., 165.];
    let angles: Vec<f64> = degrees.iter().map(|d| 0.2 + d.to_radians()).collect();
    assert!(faceted(&tangent_faces(&angles, &[0.; 5], &[0.; 5])).is_none());
}

#[test]
fn issue_6893_a_face_off_the_common_apothem_is_not_a_polygon() {
    let angles = octagon(&[0., 1., 2., 3., 4.]);
    assert!(faceted(&tangent_faces(&angles, &[0.; 5], &[0.; 5])).is_some());
    // One face 5 cm out: the ring keeps it (15 % plus twice the tolerance),
    // the polygon's 2 cm does not.
    assert!(faceted(&tangent_faces(&angles, &[0., 0., 0.05, 0., 0.], &[0.; 5])).is_none());
}

#[test]
fn issue_6893_an_end_face_running_on_as_a_wall_is_not_a_side() {
    // The last face continues 1 m: a wall leaving a polygonal corner.
    let angles = octagon(&[0., 1., 2., 3.]);
    assert!(faceted(&tangent_faces(&angles, &[0.; 4], &[0., 0., 0., 1.])).is_none());
}
