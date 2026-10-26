// SPDX-License-Identifier: MPL-2.0
//! #7955 F2: omitted X must use the actual canonical derived frame.
use super::*;

fn omitted_target(z: &str, y: &str, nonuniform: bool) -> String {
    let target = if nonuniform {
        "IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM($,#98,#84,2.,#99,3.,4.)"
    } else { "IFCCARTESIANTRANSFORMATIONOPERATOR3D($,#98,#84,1.,#99)" };
    later_target(target, &format!("#98=IFCDIRECTION({y});#99=IFCDIRECTION({z});"))
}

fn positive(bytes: &str, orientation: f64, nonuniform: bool) {
    // All three roots, source #113 before the later target, live #81 cache,
    // only one construction, two final values and canonical placement parity.
    controls::admit(bytes, 81, 96, 1);
    // Source-analytic sign/scale control, in addition to canonical parity:
    // unit orthogonal frames have |det|=1, or 2*3*4 for the nonuniform case.
    let source = SourceBundle::new(bytes.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(bytes, &mut decoder);
    let entity = decoder.decode_by_id(96).unwrap();
    let matrix = router.parse_cartesian_transformation_operator(&entity, &mut decoder).unwrap();
    let expected = orientation * if nonuniform { 24.0 } else { 1.0 };
    assert!((matrix.determinant() - expected).abs() < 1e-12, "{bytes}: {matrix:?}");
}

#[test]
fn s2_omitted_x_projection_threshold_pairs_reach_cache_after_prior_work() {
    // Decimal spellings of the binary64 threshold and its adjacent values.
    // The equality branch is fallback (strict >), as is the review's 1e-10.
    for (epsilon, fallback) in [
        ("1.E-10", true),
        ("9.999999999999999E-10", true),
        ("1.E-9", true),
        ("1.0000000000000003E-9", false),
        ("2.E-9", false),
    ] {
        for nonuniform in [false, true] {
            for z_sign in ["", "-"] {
                for mirror in [false, true] {
                    let z = format!("({z_sign}1.,0.,{epsilon})");
                    // Fallback X is ±Y, so Y=±Z is independent; above the
                    // threshold derived X is ∓Z, so Y=±Y is independent.
                    let sign = if mirror { "-" } else { "" };
                    let (y, degenerate) = if fallback {
                        (format!("(0.,0.,{sign}1.)"), format!("(0.,{sign}1.,0.)"))
                    } else {
                        (format!("(0.,{sign}1.,0.)"), format!("(0.,0.,{sign}1.)"))
                    };
                    // Reversing Z.x reverses derived X too: handedness stays
                    // positive until the supplied Y itself is mirrored.
                    let orientation = if mirror { -1.0 } else { 1.0 };
                    positive(&omitted_target(&z, &y, nonuniform), orientation, nonuniform);
                    // Same reached source/cache observer, direction-specific
                    // whole-plan refusal, even though exact raw Y/Z rank is 2.
                    rank_refusal(&omitted_target(&z, &degenerate, nonuniform), MappingReason::DependentTriple);
                }
            }
        }
    }
}

#[test]
fn s2_omitted_x_tiny_z_normalization_threshold_pairs_keep_canonical_span() {
    for (magnitude, fallback) in [
        ("5.E-324", true), ("1.E-10", true),
        ("9.999999999999999E-10", true), ("1.E-9", true),
        ("1.0000000000000003E-9", false), ("2.E-9", false),
    ] {
        for nonuniform in [false, true] {
            for z_sign in ["", "-"] {
                for mirror in [false, true] {
                    let z = format!("({z_sign}{magnitude},0.,0.)");
                    let sign = if mirror { "-" } else { "" };
                    // Tiny Z normalizes to +Z: derived X=+X, positive Y=±Y.
                    // Larger Z normalizes to ±X: derived X=±Y, positive Y=±Z.
                    let (y, degenerate) = if fallback {
                        (format!("(0.,{sign}1.,0.)"), format!("(0.,0.,{sign}1.)"))
                    } else {
                        (format!("(0.,0.,{sign}1.)"), format!("(0.,{sign}1.,0.)"))
                    };
                    positive(&omitted_target(&z, &y, nonuniform),
                        if mirror { -1.0 } else { 1.0 }, nonuniform);
                    rank_refusal(&omitted_target(&z, &degenerate, nonuniform), MappingReason::DependentTriple);
                }
            }
        }
    }
}

#[test]
fn s2_omitted_x_recovery_cannot_replace_actual_authored_pair_rank() {
    // Tiny authored Z is parallel to Y; canonical recovery to +Z would hide
    // that dependence. Omission does not authorize altering authored rank.
    for nonuniform in [false, true] {
        for y in ["(0.,1.,0.)", "(0.,-1.,0.)"] {
            rank_refusal(&omitted_target("(0.,1.E-10,0.)", y, nonuniform), MappingReason::DependentPair);
        }
    }
}

#[test]
fn s2_omitted_x_unreliable_derived_frame_refuses_before_canonical_matrix() {
    // Finite leaves but overflowing norm: canonical normalization may yield
    // zero Z. Refuse explicitly before a derived nonfinite cross product can
    // reach rational arithmetic or the later R2 matrix guard.
    for nonuniform in [false, true] {
        rank_refusal(&omitted_target("(1.E300,0.,0.)", "(0.,1.,0.)", nonuniform), MappingReason::DependentPair);
    }
}
