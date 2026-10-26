// SPDX-License-Identifier: MPL-2.0
//! #7955 remaining R1: directions must be admitted before canonical recovery.
use super::*;

const AXES: &str = "#97=IFCDIRECTION((1.,0.,0.));#98=IFCDIRECTION((0.,1.,0.));#99=IFCDIRECTION((0.,0.,1.));#100=IFCDIRECTION((1.,0.));#101=IFCDIRECTION((0.,1.));";

fn later_origin(origin: &str, leaves: &str) -> String {
    two_occurrences("#94,#82", &format!(
        "#94=IFCREPRESENTATIONMAP(#96,#95);#95=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#113));#96={origin};{leaves}"))
}

fn later_target(target: &str, leaves: &str) -> String {
    two_occurrences("#81,#96", &format!("#96={target};{leaves}"))
}

fn refuse(bytes: &str, entity: u32, cause: ExpectedCause) {
    assert_late_refusal(bytes, FailureSite::MappingDirection, entity, cause);
}

fn rank_refusal(bytes: &str, reason: MappingReason) {
    refuse(bytes, 96, ExpectedCause::Mapping(reason));
}

fn every_direction_slot(token: &str, leaves: &str,
    expected: impl Fn(usize, usize) -> (u32, ExpectedCause)) {
    for (dimension, attribute, origin) in [
        (3, 1, format!("IFCAXIS2PLACEMENT3D(#4,{token},#97)")),
        (3, 2, format!("IFCAXIS2PLACEMENT3D(#4,#99,{token})")),
        (2, 1, format!("IFCAXIS2PLACEMENT2D(#4,{token})")),
    ] {
        let (id, cause) = expected(dimension, attribute);
        refuse(&later_origin(&origin, leaves), id, cause);
    }
    for (dimension, attribute, target) in [
        (3, 0, format!("IFCCARTESIANTRANSFORMATIONOPERATOR3D({token},$,#84,1.,$)")),
        (3, 1, format!("IFCCARTESIANTRANSFORMATIONOPERATOR3D($,{token},#84,1.,$)")),
        (3, 4, format!("IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#84,1.,{token})")),
        (2, 0, format!("IFCCARTESIANTRANSFORMATIONOPERATOR2D({token},$,#84,1.)")),
        (2, 1, format!("IFCCARTESIANTRANSFORMATIONOPERATOR2D($,{token},#84,1.)")),
        (3, 0, format!("IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM({token},$,#84,1.,$,$,$)")),
        (3, 1, format!("IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM($,{token},#84,1.,$,$,$)")),
        (3, 4, format!("IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM($,$,#84,1.,{token},$,$)")),
        (2, 0, format!("IFCCARTESIANTRANSFORMATIONOPERATOR2DNONUNIFORM({token},$,#84,1.,$)")),
        (2, 1, format!("IFCCARTESIANTRANSFORMATIONOPERATOR2DNONUNIFORM($,{token},#84,1.,$)")),
    ] {
        let (id, cause) = expected(dimension, attribute);
        refuse(&later_target(&target, leaves), id, cause);
    }
}

#[test]
fn s2_r1_explicit_direction_tokens_refuse_after_contribution_in_every_slot() {
    for token in ["*", "1.", "'bad'", "(#97)", "IFCDIRECTION((1.,0.,0.))", "#4"] {
        every_direction_slot(token, AXES, |_, attribute| if token == "#4" {
            (4, ExpectedCause::Mapping(MappingReason::DirectionCategory))
        } else { (96, ExpectedCause::Mapping(MappingReason::OptionalDirectionReference { attribute })) });
    }
}

#[test]
fn s2_r1_zero_directions_refuse_after_contribution_in_every_slot() {
    for (ratios, actual) in [("(0.,0.,0.)", 3), ("(0.,0.)", 2)] {
        every_direction_slot("#102", &format!("{AXES}#102=IFCDIRECTION({ratios});"), |expected, _|
            (102, ExpectedCause::Mapping(if actual == expected { MappingReason::ZeroDirection }
                else { MappingReason::DirectionDimension { expected, actual } })));
    }
}

#[test]
fn s2_r1_direction_leaves_require_finite_numeric_components_and_matching_dimensions() {
    for (ratios, actual) in [("(1.)", 1), ("(1.,0.,0.,0.)", 4),
        ("(1.E999,0.,0.)", 3), ("(1.E999,0.)", 2), ("('bad',0.,0.)", 3), ("(IFCREAL(1.),0.)", 2)] {
        let leaves = format!("{AXES}#102=IFCDIRECTION({ratios});");
        every_direction_slot("#102", &leaves, |expected, _| (102, if actual != expected {
            ExpectedCause::Mapping(MappingReason::DirectionDimension { expected, actual })
        } else { ExpectedCause::Malformed(102) }));
    }
    // Valid leaves in the wrong dimensional frame must not be padded to fit.
    for (ratios, expected, actual, placement, target) in [
        ("(1.,0.)", 3, 2, "IFCAXIS2PLACEMENT3D(#4,#99,#102)", "IFCCARTESIANTRANSFORMATIONOPERATOR3D(#102,$,#84,1.,$)"),
        ("(1.,0.,0.)", 2, 3, "IFCAXIS2PLACEMENT2D(#4,#102)", "IFCCARTESIANTRANSFORMATIONOPERATOR2D(#102,$,#84,1.)"),
    ] {
        let leaves = format!("{AXES}#102=IFCDIRECTION({ratios});");
        let cause = ExpectedCause::Mapping(MappingReason::DirectionDimension { expected, actual });
        refuse(&later_origin(placement, &leaves), 102, cause);
        refuse(&later_target(target, &leaves), 102, cause);
    }
    for ratios in ["$", "1.", "*"] {
        every_direction_slot("#102", &format!("{AXES}#102=IFCDIRECTION({ratios});"), |_, _|
            (102, ExpectedCause::Mapping(MappingReason::DirectionRatiosList)));
    }
    every_direction_slot("#999", AXES, |_, _| (999, ExpectedCause::Missing(999)));
}

#[test]
fn s2_r1_parallel_and_coplanar_authored_axes_refuse_after_contribution() {
    for placement in ["IFCAXIS2PLACEMENT3D(#4,#99,#99)", "IFCAXIS2PLACEMENT3D(#4,#97,#102)",
        "IFCAXIS2PLACEMENT3D(#4,$,#99)"] {
        rank_refusal(&later_origin(placement, &format!("{AXES}#102=IFCDIRECTION((-2.,0.,0.));")), MappingReason::DependentPair);
    }
    for (target, reason) in [
        ("IFCCARTESIANTRANSFORMATIONOPERATOR3D(#97,#97,#84,1.,$)", MappingReason::DependentTriple),
        ("IFCCARTESIANTRANSFORMATIONOPERATOR3D(#99,$,#84,1.,#99)", MappingReason::DependentPair),
        ("IFCCARTESIANTRANSFORMATIONOPERATOR3D($,#99,#84,1.,#99)", MappingReason::DependentPair),
        ("IFCCARTESIANTRANSFORMATIONOPERATOR3D(#97,#102,#84,1.,#99)", MappingReason::DependentTriple),
        ("IFCCARTESIANTRANSFORMATIONOPERATOR3D(#99,$,#84,1.,$)", MappingReason::DependentPair),
        ("IFCCARTESIANTRANSFORMATIONOPERATOR3D($,#97,#84,1.,$)", MappingReason::DependentTriple),
        ("IFCCARTESIANTRANSFORMATIONOPERATOR3D($,#99,#84,1.,$)", MappingReason::DependentPair),
        ("IFCCARTESIANTRANSFORMATIONOPERATOR2D(#100,#100,#84,1.)", MappingReason::DependentPair),
        ("IFCCARTESIANTRANSFORMATIONOPERATOR2DNONUNIFORM(#100,#103,#84,1.,$)", MappingReason::DependentPair),
    ] {
        rank_refusal(&later_target(target, &format!("{AXES}#102=IFCDIRECTION((1.,0.,1.));#103=IFCDIRECTION((-2.,0.));")), reason);
    }
}

#[test]
fn s2_r1_direct_type_map_direction_refusal_stays_after_source_construction() {
    for (placement, id, reason) in [
        ("IFCAXIS2PLACEMENT3D(#4,*,*)", 96, MappingReason::OptionalDirectionReference { attribute: 1 }),
        ("IFCAXIS2PLACEMENT3D(#4,#102,#97)", 102, MappingReason::ZeroDirection),
        ("IFCAXIS2PLACEMENT3D(#4,#99,#102)", 102, MappingReason::ZeroDirection),
        ("IFCAXIS2PLACEMENT3D(#4,#99,#99)", 96, MappingReason::DependentPair),
    ] {
        let bytes = SOURCE.replace("#61=IFCREPRESENTATIONMAP(#7,#12)", "#61=IFCREPRESENTATIONMAP(#96,#12)")
            .replace("ENDSEC;END-ISO", &format!("#96={placement};{AXES}#102=IFCDIRECTION((0.,0.,0.));ENDSEC;END-ISO"));
        let source = SourceBundle::new(bytes.as_bytes().to_vec());
        let mut decoder = source.decoder();
        let router = GeometryRouter::with_units(&bytes, &mut decoder);
        let mut program = RetainedProgram::type_map(decoder.decode_by_id(61).unwrap(), None, contract());
        let operations = drive(&mut program, &router, &mut decoder);
        assert_eq!(operations.len(), 1, "origin admission must stay late");
        assert!(matches!(operations[0].value().definition(), LogicalRetainedDefinition::Source { source_id: 13, .. }));
        let failure = origin(program.finish_type_map(60, 1, [1.; 4]).unwrap_err());
        assert_origin(&failure, FailureSite::MappingDirection, id, ExpectedCause::Mapping(reason));
    }
}

#[test]
fn s2_r1_typed_numeric_scale_is_not_optional_omission() {
    for (attribute, target) in [
        (3, "IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#84,IFCREAL(1.),$)"),
        (3, "IFCCARTESIANTRANSFORMATIONOPERATOR2D($,$,#84,IFCREAL(1.))"),
        (4, "IFCCARTESIANTRANSFORMATIONOPERATOR2DNONUNIFORM($,$,#84,1.,IFCREAL(1.))"),
        (5, "IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM($,$,#84,1.,$,IFCREAL(1.),1.)"),
        (6, "IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM($,$,#84,1.,$,1.,IFCREAL(1.))"),
    ] { assert_late_refusal(&later_target(target, ""), FailureSite::MappingScale, 96,
        ExpectedCause::Mapping(MappingReason::FiniteScale { attribute })); }
}

#[path = "mapping_direction_controls_tests.rs"]
mod controls;
#[path = "mapping_certified_direction_tests.rs"]
mod certified;
#[path = "mapping_omission_direction_tests.rs"]
mod omission;
