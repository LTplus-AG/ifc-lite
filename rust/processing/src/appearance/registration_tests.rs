// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::*;

fn request() -> ScanRegistrationRequest {
    let points = [
        [0., 0., 0.],
        [2., 0., 0.],
        [0., 3., 0.],
        [0., 0., 4.],
        [2., 3., 4.],
        [-2., 1., 3.],
        [3., -1., 2.],
        [1., 4., -2.],
    ];
    let pairs: Vec<_> = points
        .into_iter()
        .enumerate()
        .map(|(i, source)| ScanCorrespondence {
            id: format!("p{i}"),
            source_observation: format!("row:{i}"),
            target_feature: format!("GlobalId:corner:{i}"),
            source,
            target: [-source[1] + 10., source[0] - 5., source[2] + 2.],
        })
        .collect();
    ScanRegistrationRequest {
        source_frame: RegistrationFrame {
            asset_sha256: "a".repeat(64),
            frame_key: "scan-native-metres-v1".into(),
        },
        target_frame: RegistrationFrame {
            asset_sha256: "b".repeat(64),
            frame_key: "ifc-world-z-up-revision-5".into(),
        },
        fit: pairs[..4].to_vec(),
        held_out: pairs[4..].to_vec(),
    }
}
fn solve(r: &ScanRegistrationRequest) -> ScanRegistrationReport {
    register_scan_correspondences(r).unwrap()
}

#[test]
fn issue_4381_recovers_known_proper_rigid_transform_and_held_out_vectors() {
    let mut r = request();
    r.held_out[0].target[0] += 0.03;
    r.held_out[0].target[2] -= 0.04;
    let result = solve(&r);
    assert!(result.fit.max_metres.unwrap() < 1e-12);
    assert!((result.held_out.points[0].vector_metres[0] + 0.03).abs() < 1e-12);
    assert!((result.held_out.points[0].vector_metres[2] - 0.04).abs() < 1e-12);
    assert!((result.held_out.max_metres.unwrap() - 0.05).abs() < 1e-12);
    assert!((result.held_out.rms_metres.unwrap() - 0.025).abs() < 1e-12);
    assert_eq!(result.source_frame, r.source_frame);
    assert_eq!(result.target_frame, r.target_frame);
}
#[test]
fn issue_4381_held_out_outliers_never_change_fit_or_transform() {
    let mut r = request();
    let before = solve(&r);
    r.held_out[0].target = [900., -800., 700.];
    r.held_out.reverse();
    let after = solve(&r);
    assert_eq!(before.rotation, after.rotation);
    assert_eq!(before.source_anchor, after.source_anchor);
    assert_eq!(before.target_anchor, after.target_anchor);
    assert_eq!(before.fit.rms_metres, after.fit.rms_metres);
    assert_ne!(before.request_sha256, after.request_sha256);
    assert!(after.held_out.max_metres.unwrap() > 1000.);
    assert_eq!(after.held_out.points.len(), 4); // No convenient outlier removal.
}
#[test]
fn issue_4381_planar_non_collinear_minimum_is_valid_but_not_acceptance() {
    let mut r = request();
    r.fit.truncate(3);
    r.held_out.clear();
    let result = solve(&r);
    assert!(result.fit.max_metres.unwrap() < 1e-12);
    assert!(result.source_spread.non_planarity_ratio < 1e-12);
    assert_eq!(result.held_out.rms_metres, None);
    assert_eq!(result.held_out.max_metres, None);
    assert!(result.diagnostics.iter().any(|d| d.contains("Planar")));
    assert!(result.diagnostics.iter().any(|d| d.contains("four")));
}
#[test]
fn issue_4381_rejects_collinear_source_and_target_and_near_collinear_sets() {
    for source in [true, false] {
        let mut r = request();
        for (i, p) in r.fit.iter_mut().enumerate() {
            if source {
                p.source = [i as f64, 0., 0.];
            } else {
                p.target = [i as f64, 0., 0.];
            }
        }
        assert!(register_scan_correspondences(&r)
            .unwrap_err()
            .contains("collinear"));
    }
    let mut r = request();
    for (i, p) in r.fit.iter_mut().enumerate() {
        p.source = [i as f64, (i % 2) as f64 * 1e-7, 0.];
    }
    assert!(register_scan_correspondences(&r)
        .unwrap_err()
        .contains("collinear"));
}
#[test]
fn issue_4381_mirrored_full_rank_matches_do_not_emit_reflection() {
    let mut r = request();
    for p in r.fit.iter_mut().chain(&mut r.held_out) {
        p.target = [-p.source[0], p.source[1], p.source[2]];
    }
    let result = solve(&r);
    let rotation = Matrix3::from_fn(|i, j| result.rotation[i][j]);
    assert!((rotation.determinant() - 1.).abs() < 1e-12);
    assert!(result.fit.rms_metres.unwrap() > 0.1);
    assert!(result.diagnostics.iter().any(|d| d.contains("reflect")));
}
#[test]
fn issue_4381_scale_mismatch_remains_visible_instead_of_rescaling() {
    let mut r = request();
    for p in r.fit.iter_mut().chain(&mut r.held_out) {
        p.target = p.source.map(|v| 2. * v);
    }
    let result = solve(&r);
    let rotation = Matrix3::from_fn(|i, j| result.rotation[i][j]);
    assert!((rotation.transpose() * rotation - Matrix3::identity()).norm() < 1e-12);
    assert!(result.fit.rms_metres.unwrap() > 1.);
    assert!(result.held_out.max_metres.unwrap() > 1.);
}
#[test]
fn issue_4381_duplicate_observations_cannot_leak_into_checks_under_renamed_pairs() {
    for mode in 0..5 {
        let mut r = request();
        match mode {
            0 => r.held_out[0].id = r.fit[0].id.clone(),
            1 => r.held_out[0].source_observation = r.fit[0].source_observation.clone(),
            2 => r.held_out[0].target_feature = r.fit[0].target_feature.clone(),
            3 => r.held_out[0].source = [-0., 0., 0.],
            _ => r.held_out[0].target = r.fit[0].target,
        }
        assert!(register_scan_correspondences(&r)
            .unwrap_err()
            .contains("distinct"));
    }
}
#[test]
fn issue_4381_frame_revision_asset_and_partition_are_bound_to_report() {
    let r = request();
    let original = solve(&r).request_sha256;
    for mode in 0..5 {
        let mut changed = r.clone();
        match mode {
            0 => changed.source_frame.frame_key.push('2'),
            1 => changed.target_frame.frame_key.push('2'),
            2 => changed.source_frame.asset_sha256 = "c".repeat(64),
            3 => changed.target_frame.asset_sha256 = "d".repeat(64),
            _ => std::mem::swap(&mut changed.fit[3], &mut changed.held_out[0]),
        }
        assert_ne!(original, solve(&changed).request_sha256);
    }
}
#[test]
fn issue_4381_bounds_and_nonfinite_values_fail_before_solving() {
    let mut r = request();
    r.fit = vec![r.fit[0].clone(); 257];
    assert!(register_scan_correspondences(&r)
        .unwrap_err()
        .contains("256"));
    for value in [f64::NAN, f64::INFINITY, 1e13] {
        let mut r = request();
        r.held_out[0].source[0] = value;
        assert!(register_scan_correspondences(&r)
            .unwrap_err()
            .contains("finite"));
    }
    let mut r = request();
    r.source_frame.asset_sha256 = "not-a-hash".into();
    assert!(register_scan_correspondences(&r)
        .unwrap_err()
        .contains("SHA-256"));
}
#[test]
fn issue_4381_anchored_evaluation_preserves_local_accuracy_in_georeferenced_frames() {
    let mut r = request();
    for p in r.fit.iter_mut().chain(&mut r.held_out) {
        for i in 0..3 {
            p.source[i] += 5_000_000.;
            p.target[i] += 7_000_000.;
        }
    }
    let result = solve(&r);
    assert!(result.fit.max_metres.unwrap() < 2e-9);
    assert!(result.held_out.max_metres.unwrap() < 2e-9);
}

#[test]
fn issue_4381_thin_accepted_correspondences_recover_rotation_without_squaring_loss() {
    // Independently generated exact rigid case exposed a 0.67 rotation-component
    // error through real WASM's specialized 3x3 SVD despite passing rank checks.
    for json in [
        include_str!("registration_thin_fixture.json"),
        include_str!("registration_anisotropic_fixture.json"),
    ] {
        let fixture: serde_json::Value = serde_json::from_str(json).unwrap();
        let request: ScanRegistrationRequest =
            serde_json::from_value(fixture["request"].clone()).unwrap();
        let expected: [[f64; 3]; 3] =
            serde_json::from_value(fixture["expectedRotation"].clone()).unwrap();
        let result = solve(&request);
        assert!(result.source_spread.non_collinearity_ratio >= MIN_NON_COLLINEARITY);
        for (actual, expected) in result
            .rotation
            .iter()
            .flatten()
            .zip(expected.iter().flatten())
        {
            assert!(
                (actual - expected).abs() < 1e-6,
                "rotation component {actual} vs {expected}"
            );
        }
        assert!(result.fit.max_metres.unwrap() < 1e-8);
        assert!(result.held_out.max_metres.unwrap() < 1e-8);
    }
}
