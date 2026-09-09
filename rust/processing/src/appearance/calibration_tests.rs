// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::*;

fn request() -> PlaneCalibrationRequest {
    PlaneCalibrationRequest {
        // A cropped PDF raster with native Y pointing upward, 2 pixels/native unit.
        raster_to_source: [0.5, 0., 0., -0.5, 10., 120.],
        raster_size: [400, 200], source_points: [[10., 20.], [110., 20.]],
        distance_metres: 10., world_anchor: [1000., 2000., 3.],
        world_direction: [2., 0., 0.], plane_normal: [0., 0., 4.],
    }
}
fn close(actual: [f64; 3], expected: [f64; 3]) {
    for (a, b) in actual.into_iter().zip(expected) { assert!((a - b).abs() < 1e-9, "{actual:?} != {expected:?}"); }
}

#[test]
fn issue_4260_measured_span_sets_one_world_plane_independent_of_paper_dpi() {
    let r = request();
    let plane = calibrate_appearance_plane(&r).unwrap();
    close(plane.raster_corners[0], [1000., 2010., 3.]);
    close(plane.raster_corners[1], [1020., 2010., 3.]);
    close(plane.raster_corners[2], [1020., 2000., 3.]);
    close(plane.raster_corners[3], [1000., 2000., 3.]);
    assert_eq!(plane.metres_per_source_unit, 0.1);
    let Mapping::Planar { origin, axis_u, axis_v, metres_per_tile, frame } = plane.mapping else { panic!("Expected planar mapping") };
    assert!(matches!(frame, MappingFrame::World));
    assert_eq!(origin, [1000., 2000., 3.]);
    assert_eq!(axis_u, [1., 0., 0.]);
    assert_eq!(axis_v, [0., 1., 0.]);
    assert_eq!(metres_per_tile, [20., 10.]);
    let mut higher_dpi = r;
    higher_dpi.raster_size = [800, 400];
    higher_dpi.raster_to_source[..4].iter_mut().for_each(|v| *v *= 0.5);
    assert_eq!(calibrate_appearance_plane(&higher_dpi).unwrap().raster_corners, plane.raster_corners);
}

#[test]
fn issue_4260_crop_rotation_and_user_unit_do_not_recalibrate_native_landmarks() {
    let mut r = request();
    // Clockwise rotation of the same rectangle: new top-left is old bottom-left.
    r.raster_to_source = [0., 0.5, 0.5, 0., 10., 20.];
    r.raster_size = [200, 400];
    let rotated = calibrate_appearance_plane(&r).unwrap();
    close(rotated.raster_corners[0], [1000., 2000., 3.]);
    close(rotated.raster_corners[1], [1000., 2010., 3.]);
    close(rotated.raster_corners[2], [1020., 2010., 3.]);
    // A smaller crop retains the measured source points even outside its bounds.
    r.raster_to_source = [0.25, 0., 0., -0.25, 60., 95.];
    r.raster_size = [200, 200];
    let cropped = calibrate_appearance_plane(&r).unwrap();
    close(cropped.raster_corners[0], [1005., 2007.5, 3.]);
    close(cropped.raster_corners[2], [1010., 2002.5, 3.]);
    // UserUnit influences the decoder's pixel->native affine. Once that affine
    // and native landmarks are supplied, physical paper units are not applied twice.
    r.raster_size = [400, 400];
    r.raster_to_source[..4].iter_mut().for_each(|v| *v *= 0.5);
    assert_eq!(calibrate_appearance_plane(&r).unwrap().raster_corners, cropped.raster_corners);
}

#[test]
fn issue_4260_diagonal_landmarks_and_vertical_plane_preserve_known_distance() {
    let mut r = request();
    r.source_points = [[0., 0.], [3., 4.]];
    r.distance_metres = 10.;
    r.world_anchor = [0., 0., 5.];
    r.world_direction = [0., 0., 1.];
    r.plane_normal = [0., -1., 0.];
    // Raster edge endpoints land exactly on the two calibration landmarks.
    r.raster_to_source = [0.003, 0.004, 0.004, -0.003, 0., 0.];
    r.raster_size = [1000, 1000];
    let plane = calibrate_appearance_plane(&r).unwrap();
    close(plane.raster_corners[0], [0., 0., 5.]);
    close(plane.raster_corners[1], [0., 0., 15.]);
    // Native clockwise perpendicular (4,-3) points opposite normal×direction.
    close(plane.raster_corners[2], [10., 0., 15.]);
}

#[test]
fn issue_4260_partial_coordinate_collapse_rejects_distorted_diagonal_planes() {
    let mut r = request();
    r.world_anchor = [1e16, 0., 0.];
    r.world_direction = [1., 1., 0.];
    r.plane_normal = [0., 0., 1.];
    r.raster_to_source = [1., 0., 0., -1., 0., 1.];
    r.raster_size = [1, 1];
    r.source_points = [[0., 0.], [1., 0.]];
    r.distance_metres = 1.;
    assert!(calibrate_appearance_plane(&r).unwrap_err().contains("coordinate precision"));

    // Ordinary georeferencing remains usable without giving distorted large
    // coordinates a tolerance proportional to their absolute magnitude.
    r.world_anchor = [5_000_000., 4_000_000., 100.];
    let plane = calibrate_appearance_plane(&r).unwrap();
    for edge in 0..4 {
        let delta = std::array::from_fn(|i| plane.raster_corners[(edge + 1) % 4][i]
            - plane.raster_corners[edge][i]);
        assert!((length(delta) - 1.).abs() < 1e-8);
    }
    // A long horizontal edge must not mask loss of the narrow vertical edge.
    r.world_direction = [1., 0., 0.];
    r.world_anchor = [0., 1e16, 0.];
    r.raster_to_source = [1e10, 0., 0., -1., 0., 0.];
    assert!(calibrate_appearance_plane(&r).is_err());
}

#[test]
fn issue_4260_invalid_or_unrepresentable_calibration_is_never_a_default_scale() {
    let cases: [fn(&mut PlaneCalibrationRequest); 12] = [
        |r| r.source_points[1] = r.source_points[0],
        |r| r.distance_metres = 0.,
        |r| r.distance_metres = f64::INFINITY,
        |r| r.raster_to_source[0] = f64::NAN,
        |r| r.raster_to_source[2] = 0.25, // shear
        |r| r.raster_to_source[3] = 0., // singular
        |r| r.world_direction = [0., 0., 1.], // outside plane
        |r| r.plane_normal = [0., 0., 0.],
        |r| r.raster_size = [8192, 8192],
        |r| r.raster_size = [0, 10],
        |r| r.world_anchor = [1e30, 1e30, 1e30],
        |r| r.raster_to_source[4] = f64::MAX,
    ];
    for (index, change) in cases.into_iter().enumerate() {
        let mut r = request(); change(&mut r);
        assert!(calibrate_appearance_plane(&r).is_err(), "invalid case {index} was accepted");
    }
}
