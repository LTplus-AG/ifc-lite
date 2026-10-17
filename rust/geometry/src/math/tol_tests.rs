// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Pins for the tolerance catalogue (F2c, #7774): every value is the literal it
//! replaced, the clash twins still agree, and the inline epsilon count in
//! `rust/geometry/src` only goes down.

use super::tol::*;
use std::path::{Path, PathBuf};

/// F2c is a refactor, so each constant must equal the literal that shipped. A
/// deliberate policy change edits this table in the same commit (C3 does).
#[test]
fn values_are_the_shipped_literals() {
    let pins: &[(&str, f64, f64)] = &[
        ("SINGULAR_DET_EPS", SINGULAR_DET_EPS, 1e-18),
        ("NORMALIZE_NONZERO", NORMALIZE_NONZERO, 0.0),
        ("DIRECTION_MIN_LEN", DIRECTION_MIN_LEN, 1e-12),
        ("AXIS_MIN_LEN", AXIS_MIN_LEN, 1e-9),
        ("EDGE_CROSS_MIN_LEN", EDGE_CROSS_MIN_LEN, 1e-10),
        ("COARSE_DIRECTION_MIN_LEN", COARSE_DIRECTION_MIN_LEN, 1e-6),
        ("IDENTITY_EPS", IDENTITY_EPS, 1e-9),
        ("IDENTITY_EPS_STRICT", IDENTITY_EPS_STRICT, 1e-12),
        ("PLACEMENT_2D_EPS", PLACEMENT_2D_EPS, 1e-10),
        ("PARALLEL_EPS", PARALLEL_EPS, 1e-9),
        ("ORTHO_EPS", ORTHO_EPS, 1.0e-4),
        ("MIN_SIN_THETA", MIN_SIN_THETA, 1.0e-3),
        ("F32_HALF_ULP_REL", F32_HALF_ULP_REL, 2f64.powi(-24)),
        ("F32_ULP_REL", F32_ULP_REL, f64::from(f32::EPSILON)),
        ("F32_ULP_SCALE", F32_ULP_SCALE, 2f64.powi(-22)),
        ("F32_ULP_8", F32_ULP_8, 9.5367431640625e-7),
        ("POINT_COINCIDENT_EPS", POINT_COINCIDENT_EPS, 1e-9),
        ("LENGTH_ZERO_EPS", LENGTH_ZERO_EPS, 1e-9),
        ("CURVE_JUNCTION_EPS", CURVE_JUNCTION_EPS, 1e-6),
        ("SEAM_EPS", SEAM_EPS, 1e-9),
        ("PARAM_EPS", PARAM_EPS, 1e-9),
        ("SAMPLE_COINCIDENT_SQ", SAMPLE_COINCIDENT_SQ, 1e-12),
        ("SAMPLE_END_COINCIDENT_SQ", SAMPLE_END_COINCIDENT_SQ, 1e-18),
        ("TRIM_SPAN_MIN", TRIM_SPAN_MIN, 1e-12),
        ("PARAM_END_MARGIN", PARAM_END_MARGIN, 1e-6),
        ("BASIS_EPS", BASIS_EPS, 1e-10),
        ("ANGLE_EPS", ANGLE_EPS, 1e-6),
        ("ARC_COINCIDENT_REL", ARC_COINCIDENT_REL, 1e-6),
        ("ARC_SWEEP_MIN", ARC_SWEEP_MIN, 1e-9),
        ("CHORD_TOL_M", CHORD_TOL_M, 5.0e-4),
        ("PARTIAL_VOID_EPS", PARTIAL_VOID_EPS, 0.001),
        ("MIN_PROFILE_DIMENSION", MIN_PROFILE_DIMENSION, 0.001),
        ("EXTRUSION_AXIS_COMPONENT_EPS", EXTRUSION_AXIS_COMPONENT_EPS, 0.001),
    ];
    for (name, got, want) in pins {
        assert_eq!(got.to_bits(), want.to_bits(), "{name} moved: {got:e} != {want:e}");
    }
}

fn read_clash(file: &str) -> String {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../clash/src").join(file);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()))
}

/// D21: `ifc-lite-clash` does not depend on geometry, so it keeps its own
/// copies of three catalogue values. They must not drift.
#[test]
fn clash_copies_agree_with_the_catalogue() {
    let depth = read_clash("depth.rs");
    assert!(
        depth.contains("F32_ULP_SCALE: f64 = 1.0 / 4_194_304.0;"),
        "clash depth.rs F32_ULP_SCALE no longer 2^-22 (catalogue: {F32_ULP_SCALE:e})"
    );
    let obb = read_clash("obb_detect.rs");
    assert!(
        obb.contains("MIN_SIN_THETA: f64 = 1.0e-3;"),
        "clash obb_detect.rs MIN_SIN_THETA moved (catalogue: {MIN_SIN_THETA:e})"
    );
}

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap().flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if path.is_dir() {
            rust_files(&path, out);
        } else if name.ends_with(".rs") && !name.ends_with("_tests.rs") && name != "tests.rs" {
            out.push(path);
        }
    }
}

/// Counts `1e-N` / `1.0e-N` literals outside comments.
fn count_epsilon_literals(src: &str) -> usize {
    let mut n = 0;
    for line in src.lines() {
        let code = line.split("//").next().unwrap_or("");
        let b = code.as_bytes();
        for i in 0..b.len().saturating_sub(2) {
            if b[i] != b'e' || b[i + 1] != b'-' || !b[i + 2].is_ascii_digit() {
                continue;
            }
            let (mantissa, start) = if i >= 3 && &b[i - 3..i] == b"1.0" {
                (true, i - 3)
            } else if i >= 1 && b[i - 1] == b'1' {
                (true, i - 1)
            } else {
                (false, 0)
            };
            let boundary = start == 0 || !(b[start - 1].is_ascii_alphanumeric() || b[start - 1] == b'.' || b[start - 1] == b'_');
            if mantissa && boundary {
                n += 1;
            }
        }
    }
    n
}

/// The ratchet: new tolerance literals go through `math::tol` (or a named,
/// documented local constant), so this ceiling only ever goes down (lower it when you remove literals).
/// Counts every `1e-N` / `1.0e-N` outside comments in `rust/geometry/src`, test
/// modules inside files included, excluding `*_tests.rs` files.
///
/// 480 = 477 on this branch's base plus the three `triangulation.rs` literals
/// #7826 landed on main concurrently (GEOM-38 territory, C3 names them).
const MAX_INLINE_EPSILON_LITERALS: usize = 480;

#[test]
fn inline_epsilon_literals_only_go_down() {
    let mut files = Vec::new();
    rust_files(&Path::new(env!("CARGO_MANIFEST_DIR")).join("src"), &mut files);
    let total: usize = files
        .iter()
        .map(|f| count_epsilon_literals(&std::fs::read_to_string(f).unwrap()))
        .sum();
    assert!(
        total <= MAX_INLINE_EPSILON_LITERALS,
        "{total} inline epsilon literals in rust/geometry/src, ceiling {MAX_INLINE_EPSILON_LITERALS}. \
         Name the new tolerance in math/tol.rs (value, unit, why) instead of a bare literal."
    );
}
