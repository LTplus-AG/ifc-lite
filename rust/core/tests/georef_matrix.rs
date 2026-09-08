// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Pins `GeoReference::to_matrix()`'s rotation columns, uniform scale, and
//! translation, and cross-checks the matrix against `local_to_map` for an
//! arbitrary point. Moved out of `rust/core/src/georef.rs` to keep that file
//! under its module-size ratchet budget (see
//! `rust/processing/tests/module_size_ratchet.rs`); `to_matrix` and
//! `GeoReference` are both `pub`, so this runs as an ordinary integration
//! test against the crate's public API.

use ifc_lite_core::GeoReference;

#[test]
fn test_to_matrix_pins_rotation_scale_translation() {
    let mut georef = GeoReference::new();
    georef.eastings = 500000.0;
    georef.northings = 4000000.0;
    georef.orthogonal_height = 50.0;
    georef.scale = 2.0;
    // 30 degree rotation
    let angle = std::f64::consts::FRAC_PI_6;
    georef.x_axis_abscissa = angle.cos();
    georef.x_axis_ordinate = angle.sin();

    let m = georef.to_matrix();

    let cos_r = angle.cos();
    let sin_r = angle.sin();
    let s = georef.scale;

    // Column 0: scaled X axis.
    assert!((m[0] - s * cos_r).abs() < 1e-12);
    assert!((m[1] - s * sin_r).abs() < 1e-12);
    assert_eq!(m[2], 0.0);
    assert_eq!(m[3], 0.0);

    // Column 1: scaled Y axis. This is the column the surviving mutation
    // (`-s * sin_r` -> `+s * sin_r`) flips.
    assert!((m[4] - (-s * sin_r)).abs() < 1e-12);
    assert!((m[5] - s * cos_r).abs() < 1e-12);
    assert_eq!(m[6], 0.0);
    assert_eq!(m[7], 0.0);

    // Column 2: scaled Z axis (uniform scale applies to z too).
    assert_eq!(m[8], 0.0);
    assert_eq!(m[9], 0.0);
    assert!((m[10] - s).abs() < 1e-12);
    assert_eq!(m[11], 0.0);

    // Column 3: translation.
    assert_eq!(m[12], georef.eastings);
    assert_eq!(m[13], georef.northings);
    assert_eq!(m[14], georef.orthogonal_height);
    assert_eq!(m[15], 1.0);

    // Cross-check against `local_to_map`: applying the matrix to an
    // arbitrary local point must agree with the point-transform formula.
    // A flipped rotation sign disagrees here even if the pinned columns
    // above were missed.
    let (x, y, z) = (12.0, -7.0, 3.0);
    let px = m[0] * x + m[4] * y + m[8] * z + m[12];
    let py = m[1] * x + m[5] * y + m[9] * z + m[13];
    let pz = m[2] * x + m[6] * y + m[10] * z + m[14];

    let (e, n, h) = georef.local_to_map(x, y, z);
    assert!((px - e).abs() < 1e-9, "matrix X disagrees with local_to_map easting");
    assert!((py - n).abs() < 1e-9, "matrix Y disagrees with local_to_map northing");
    assert!((pz - h).abs() < 1e-9, "matrix Z disagrees with local_to_map height");
}
