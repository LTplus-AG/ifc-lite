// SPDX-License-Identifier: MPL-2.0
//! #7955: certify dependence on authored binary64 values, before recovery.
use super::*;

const OBLIQUE_TARGETS: [&str; 2] = [
    "IFCCARTESIANTRANSFORMATIONOPERATOR3D(#97,#98,#84,1.,#99)",
    "IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM(#97,#98,#84,1.,#99,$,$)",
];

fn oblique_axes(y_z: &str) -> String {
    format!("#97=IFCDIRECTION((4.,5.,6.));#98=IFCDIRECTION((5.,7.,{y_z}));#99=IFCDIRECTION((1.,2.,3.));")
}

#[test]
fn s2_certified_oblique_coplanar_axes_refuse_whole_plan_on_cache_hit() {
    // Y=X+Z over small exactly represented integers, and every pair is
    // nonparallel. Dividing each vector by its maximum first manufactures
    // a nonzero scalar triple product; canonical Gram-Schmidt then recovers.
    for target in OBLIQUE_TARGETS {
        // All three roots: real #113 contribution, live #81 cache, then a
        // direction-specific whole-plan failure, not an incidental early stop.
        rank_refusal(&later_target(target, &oblique_axes("9.")), MappingReason::DependentTriple);
    }
}

#[test]
fn s2_certified_nearby_independent_axes_keep_canonical_frames_and_cache_hits() {
    // Z×X=(-3,6,-3), so changing only Y.z by nonzero delta gives -3*delta.
    // The first delta is one binary64 ULP at 9; the second also exercises a
    // larger residual. Neither positive control relies on an arbitrary epsilon.
    for y_z in ["9.000000000000002", "9.0001"] {
        for target in OBLIQUE_TARGETS {
            controls::admit(&later_target(target, &oblique_axes(y_z)), 81, 96, 1);
        }
    }
}

#[test]
fn s2_certified_pair_admission_preserves_small_exact_nonzero_minors() {
    // These test the admission boundary, not canonical normalization at
    // extreme magnitudes. Full-plan canonical parity has separate controls.
    for (x, y) in [
        // det = -2^-104; rounded products (and max rescaling) can erase it.
        ("(1.0000000000000002,1.)", "(1.,0.9999999999999998)"),
        // Normalizing by 1e300 erases the smallest subnormal component.
        ("(1.E300,5.E-324)", "(1.E300,0.)"),
        // Direct floating multiplication underflows both products to zero.
        ("(5.E-324,0.)", "(0.,5.E-324)"),
    ] {
        let bytes = later_target("IFCCARTESIANTRANSFORMATIONOPERATOR2D(#97,#98,#84,1.)",
            &format!("#97=IFCDIRECTION({x});#98=IFCDIRECTION({y});"));
        let source = SourceBundle::new(bytes.as_bytes().to_vec());
        let mut decoder = source.decoder();
        let target = decoder.decode_by_id(96).unwrap();
        crate::program::mapping::MappingControl::admit_target_directions_for_test(&target, &mut decoder)
            .expect("represented nonzero minor must remain independent");
    }
}

#[test]
fn s2_certified_pair_admission_rejects_parallel_extreme_finite_axes() {
    for (z, x) in [
        // Raw floating cross products overflow to infinity-infinity/NaN.
        ("(1.E300,1.E300,1.E300)", "(2.E300,2.E300,2.E300)"),
        ("(5.E-324,5.E-324,5.E-324)", "(-5.E-324,-5.E-324,-5.E-324)"),
    ] {
        let bytes = later_origin("IFCAXIS2PLACEMENT3D(#4,#99,#97)",
            &format!("#99=IFCDIRECTION({z});#97=IFCDIRECTION({x});"));
        // Same full-plan refusal observer, after real earlier work. No numeric
        // operation on these extreme axes is needed to decide their dependence.
        rank_refusal(&bytes, MappingReason::DependentPair);
    }
}
