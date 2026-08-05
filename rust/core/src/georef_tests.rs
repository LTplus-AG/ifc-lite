// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Unit tests for `georef.rs`.
//!
//! Split out per the repo convention for modules whose bulk is test code
//! (see `rust/export/src/geom.rs` / `geom_tests.rs`), which also keeps
//! `georef.rs` inside its module-size ratchet budget.

use super::*;

#[test]
fn test_georef_local_to_map() {
    let mut georef = GeoReference::new();
    georef.eastings = 500000.0;
    georef.northings = 5000000.0;
    georef.orthogonal_height = 100.0;

    let (e, n, h) = georef.local_to_map(10.0, 20.0, 5.0);
    assert!((e - 500010.0).abs() < 1e-10);
    assert!((n - 5000020.0).abs() < 1e-10);
    assert!((h - 105.0).abs() < 1e-10);
}

#[test]
fn test_georef_map_to_local() {
    let mut georef = GeoReference::new();
    georef.eastings = 500000.0;
    georef.northings = 5000000.0;
    georef.orthogonal_height = 100.0;

    let (x, y, z) = georef.map_to_local(500010.0, 5000020.0, 105.0);
    assert!((x - 10.0).abs() < 1e-10);
    assert!((y - 20.0).abs() < 1e-10);
    assert!((z - 5.0).abs() < 1e-10);
}

#[test]
fn test_georef_with_rotation() {
    let mut georef = GeoReference::new();
    georef.eastings = 0.0;
    georef.northings = 0.0;
    // 90 degree rotation
    georef.x_axis_abscissa = 0.0;
    georef.x_axis_ordinate = 1.0;

    let (e, n, _) = georef.local_to_map(10.0, 0.0, 0.0);
    // After 90 degree rotation: (10, 0) -> (0, 10)
    assert!(e.abs() < 1e-10);
    assert!((n - 10.0).abs() < 1e-10);
}

/// `local_to_map`'s rotation must be `e = cos*x - sin*y`, `n = sin*x +
/// cos*y` — a genuine 2D rotation, not `cos*x + sin*y` for both.
///
/// `test_georef_with_rotation` above uses `x_axis_ordinate` (sin) = 1
/// with `y = 0`, and `test_georef_local_to_map` uses `sin = 0` with a
/// nonzero `y` — in both, `cos*x - sin*y` and `cos*x + sin*y` are
/// numerically identical, so a `-` to `+` typo in the `e` term left both
/// green. Only a fixture with a non-axis-aligned rotation AND nonzero x
/// *and* y forces the two terms apart.
#[test]
fn test_georef_local_to_map_rotation_sign_is_a_true_rotation() {
    let mut georef = GeoReference::new();
    georef.eastings = 0.0;
    georef.northings = 0.0;
    // 45 degrees: cos == sin, so only the +/- distinguishes e from n.
    let c = std::f64::consts::FRAC_1_SQRT_2;
    georef.x_axis_abscissa = c;
    georef.x_axis_ordinate = c;

    let (e, n, _) = georef.local_to_map(10.0, 4.0, 0.0);
    assert!((e - c * 6.0).abs() < 1e-10, "e = cos*x - sin*y, got {e}");
    assert!((n - c * 14.0).abs() < 1e-10, "n = sin*x + cos*y, got {n}");
}

#[test]
fn test_georef_map_to_local_with_rotation_round_trips_local_to_map() {
    // `test_georef_with_rotation` above only exercises local_to_map, and
    // only with y=0 -- so it cannot catch a sign error in the sin_r*y
    // term (multiplied by zero either way). `test_georef_map_to_local`
    // only exercises the identity rotation (sin_r=0), so it cannot catch
    // a sign error in map_to_local's sin_r*dx / sin_r*dy terms either.
    // Pin map_to_local under a genuine rotation with BOTH local
    // coordinates nonzero, and cross-check it inverts local_to_map.
    let mut georef = GeoReference::new();
    georef.eastings = 500000.0;
    georef.northings = 4000000.0;
    georef.orthogonal_height = 50.0;
    georef.scale = 2.0;
    let angle = std::f64::consts::FRAC_PI_6; // 30 degrees
    georef.x_axis_abscissa = angle.cos();
    georef.x_axis_ordinate = angle.sin();

    let (lx, ly, lz) = (12.0, -7.0, 3.0);
    let (e, n, h) = georef.local_to_map(lx, ly, lz);
    let (x, y, z) = georef.map_to_local(e, n, h);

    assert!((x - lx).abs() < 1e-9, "map_to_local must invert local_to_map (x), got {x}");
    assert!((y - ly).abs() < 1e-9, "map_to_local must invert local_to_map (y), got {y}");
    assert!((z - lz).abs() < 1e-9, "map_to_local must invert local_to_map (z), got {z}");
}

#[test]
fn test_rtc_offset() {
    let positions = vec![
        500000.0f32,
        5000000.0,
        0.0,
        500010.0,
        5000010.0,
        10.0,
        500020.0,
        5000020.0,
        20.0,
    ];

    let offset = RtcOffset::from_positions(&positions);
    assert!(offset.is_significant());
    assert!((offset.x - 500010.0).abs() < 1.0);
    assert!((offset.y - 5000010.0).abs() < 1.0);
}

#[test]
fn test_rtc_apply() {
    let mut positions = vec![500000.0f32, 5000000.0, 0.0, 500010.0, 5000010.0, 10.0];

    let offset = RtcOffset {
        x: 500000.0,
        y: 5000000.0,
        z: 0.0,
    };

    offset.apply(&mut positions);

    assert!((positions[0] - 0.0).abs() < 1e-5);
    assert!((positions[1] - 0.0).abs() < 1e-5);
    assert!((positions[3] - 10.0).abs() < 1e-5);
    assert!((positions[4] - 10.0).abs() < 1e-5);
}

/// `apply`'s z-channel must subtract `self.z`, not `self.x`/`self.y`.
///
/// `test_rtc_apply` above uses `z: 0.0` and never asserts on
/// `positions[2]`/`positions[5]`, so the third component of `chunk[2] =
/// chunk[2] - self.z` was free to read the wrong field of `self` — a
/// `self.x`-for-`self.z` swap left that test fully green. Distinct,
/// non-zero x/y/z offsets and asserting all three components pins it.
#[test]
fn test_rtc_apply_z_channel_uses_z_offset() {
    let mut positions = vec![100.0f32, 200.0, 300.0];

    let offset = RtcOffset {
        x: 10.0,
        y: 20.0,
        z: 30.0,
    };

    offset.apply(&mut positions);

    assert!((positions[0] - 90.0).abs() < 1e-5);
    assert!((positions[1] - 180.0).abs() < 1e-5);
    assert!((positions[2] - 270.0).abs() < 1e-5);
}
