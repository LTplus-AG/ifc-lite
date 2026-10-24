// SPDX-License-Identifier: MPL-2.0
//! #7955 remaining R1: directions must be admitted before canonical recovery.
use super::*;

const DIAGNOSTIC: &str = "retained mapping direction admission refused";
const AXES: &str = "#97=IFCDIRECTION((1.,0.,0.));#98=IFCDIRECTION((0.,1.,0.));#99=IFCDIRECTION((0.,0.,1.));#100=IFCDIRECTION((1.,0.));#101=IFCDIRECTION((0.,1.));";

fn later_origin(origin: &str, leaves: &str) -> String {
    two_occurrences("#94,#82", &format!(
        "#94=IFCREPRESENTATIONMAP(#96,#95);#95=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#113));#96={origin};{leaves}"))
}

fn later_target(target: &str, leaves: &str) -> String {
    two_occurrences("#81,#96", &format!("#96={target};{leaves}"))
}

fn refuse(bytes: &str, diagnostic: &str) {
    for mode in 0..3 {
        let source = SourceBundle::new(bytes.as_bytes().to_vec());
        let mut decoder = source.decoder();
        let router = GeometryRouter::with_units(bytes, &mut decoder);
        let entity = decoder.decode_by_id(10).unwrap();
        let mut program = match mode {
            0 => RetainedProgram::product_parts(&entity, contract()),
            1 => RetainedProgram::product_submeshes(&entity, true, None, contract()),
            _ => RetainedProgram::type_map(decoder.decode_by_id(61).unwrap(), None, contract()),
        };
        let selection = program.selection().unwrap().clone();
        let operations = drive(&mut program, &router, &mut decoder);
        assert_eq!(operations.len(), 1, "earlier contribution reached, mode {mode}: {bytes}");
        assert!(matches!(operations[0].value().definition(),
            LogicalRetainedDefinition::Source { source_id: 113, .. }));
        // In the target cases the later occurrence names this exact source.
        // Checking the live cache prevents a count-only false witness.
        let cached = selection.cached(&decoder, &router, 81).unwrap().unwrap();
        assert_eq!(cached.len(), 1);
        assert_eq!(cached[0].definition(), operations[0].value().definition());
        let result = if mode == 2 { program.finish_type_map(60, 1, [1.; 4]) }
            else { program.finish() };
        let error = result.expect_err("a malformed later occurrence must publish no whole plan");
        if !diagnostic.is_empty() {
            assert!(error.to_string().contains(diagnostic), "mode {mode}: {error}");
        }
    }
}

fn every_direction_slot(token: &str, leaves: &str, diagnostic: &str) {
    for origin in [
        format!("IFCAXIS2PLACEMENT3D(#4,{token},#97)"),
        format!("IFCAXIS2PLACEMENT3D(#4,#99,{token})"),
        format!("IFCAXIS2PLACEMENT2D(#4,{token})"),
    ] { refuse(&later_origin(&origin, leaves), diagnostic); }
    for target in [
        format!("IFCCARTESIANTRANSFORMATIONOPERATOR3D({token},$,#84,1.,$)"),
        format!("IFCCARTESIANTRANSFORMATIONOPERATOR3D($,{token},#84,1.,$)"),
        format!("IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#84,1.,{token})"),
        format!("IFCCARTESIANTRANSFORMATIONOPERATOR2D({token},$,#84,1.)"),
        format!("IFCCARTESIANTRANSFORMATIONOPERATOR2D($,{token},#84,1.)"),
        format!("IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM({token},$,#84,1.,$,$,$)"),
        format!("IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM($,{token},#84,1.,$,$,$)"),
        format!("IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM($,$,#84,1.,{token},$,$)"),
        format!("IFCCARTESIANTRANSFORMATIONOPERATOR2DNONUNIFORM({token},$,#84,1.,$)"),
        format!("IFCCARTESIANTRANSFORMATIONOPERATOR2DNONUNIFORM($,{token},#84,1.,$)"),
    ] { refuse(&later_target(&target, leaves), diagnostic); }
}

#[test]
fn s2_r1_explicit_direction_tokens_refuse_after_contribution_in_every_slot() {
    for token in ["*", "1.", "'bad'", "(#97)", "IFCDIRECTION((1.,0.,0.))", "#4"] {
        every_direction_slot(token, AXES, DIAGNOSTIC);
    }
}

#[test]
fn s2_r1_zero_directions_refuse_after_contribution_in_every_slot() {
    for ratios in ["(0.,0.,0.)", "(0.,0.)"] {
        every_direction_slot("#102", &format!("{AXES}#102=IFCDIRECTION({ratios});"), DIAGNOSTIC);
    }
}

#[test]
fn s2_r1_direction_leaves_require_finite_numeric_components_and_matching_dimensions() {
    for ratios in ["(1.)", "(1.,0.,0.,0.)", "(1.,0.)", "(1.,0.,0.)",
        "(1.E999,0.,0.)", "(1.E999,0.)", "('bad',0.,0.)", "(IFCREAL(1.),0.)"] {
        let leaves = format!("{AXES}#102=IFCDIRECTION({ratios});");
        // Valid numeric 2D and 3D leaves are deliberately used in the wrong
        // dimensional frame, so canonical padding cannot mask that mismatch.
        if ratios == "(1.,0.)" {
            refuse(&later_origin("IFCAXIS2PLACEMENT3D(#4,#99,#102)", &leaves), DIAGNOSTIC);
            refuse(&later_target("IFCCARTESIANTRANSFORMATIONOPERATOR3D(#102,$,#84,1.,$)", &leaves), DIAGNOSTIC);
        } else if ratios == "(1.,0.,0.)" {
            refuse(&later_origin("IFCAXIS2PLACEMENT2D(#4,#102)", &leaves), DIAGNOSTIC);
            refuse(&later_target("IFCCARTESIANTRANSFORMATIONOPERATOR2D(#102,$,#84,1.)", &leaves), DIAGNOSTIC);
        } else { every_direction_slot("#102", &leaves, ""); }
    }
    every_direction_slot("#999", AXES, "");
}

#[test]
fn s2_r1_parallel_and_coplanar_authored_axes_refuse_after_contribution() {
    for origin in ["IFCAXIS2PLACEMENT3D(#4,#99,#99)", "IFCAXIS2PLACEMENT3D(#4,#97,#102)",
        "IFCAXIS2PLACEMENT3D(#4,$,#99)"] {
        refuse(&later_origin(origin, &format!("{AXES}#102=IFCDIRECTION((-2.,0.,0.));")), DIAGNOSTIC);
    }
    // X/Y, X/Z, Y/Z and a pairwise nonparallel but dependent triple.
    for target in [
        "IFCCARTESIANTRANSFORMATIONOPERATOR3D(#97,#97,#84,1.,$)",
        "IFCCARTESIANTRANSFORMATIONOPERATOR3D(#99,$,#84,1.,#99)",
        "IFCCARTESIANTRANSFORMATIONOPERATOR3D($,#99,#84,1.,#99)",
        "IFCCARTESIANTRANSFORMATIONOPERATOR3D(#97,#102,#84,1.,#99)",
        "IFCCARTESIANTRANSFORMATIONOPERATOR3D(#99,$,#84,1.,$)",
        "IFCCARTESIANTRANSFORMATIONOPERATOR3D($,#97,#84,1.,$)",
        "IFCCARTESIANTRANSFORMATIONOPERATOR3D($,#99,#84,1.,$)",
        "IFCCARTESIANTRANSFORMATIONOPERATOR2D(#100,#100,#84,1.)",
        "IFCCARTESIANTRANSFORMATIONOPERATOR2DNONUNIFORM(#100,#103,#84,1.,$)",
    ] {
        refuse(&later_target(target, &format!("{AXES}#102=IFCDIRECTION((1.,0.,1.));#103=IFCDIRECTION((-2.,0.));")), DIAGNOSTIC);
    }
}

#[test]
fn s2_r1_direct_type_map_direction_refusal_stays_after_source_construction() {
    for origin in ["IFCAXIS2PLACEMENT3D(#4,*,*)", "IFCAXIS2PLACEMENT3D(#4,#102,#97)",
        "IFCAXIS2PLACEMENT3D(#4,#99,#102)", "IFCAXIS2PLACEMENT3D(#4,#99,#99)"] {
        let bytes = SOURCE.replace("#61=IFCREPRESENTATIONMAP(#7,#12)", "#61=IFCREPRESENTATIONMAP(#96,#12)")
            .replace("ENDSEC;END-ISO", &format!("#96={origin};{AXES}#102=IFCDIRECTION((0.,0.,0.));ENDSEC;END-ISO"));
        let source = SourceBundle::new(bytes.as_bytes().to_vec());
        let mut decoder = source.decoder();
        let router = GeometryRouter::with_units(&bytes, &mut decoder);
        let mut program = RetainedProgram::type_map(decoder.decode_by_id(61).unwrap(), None, contract());
        let operations = drive(&mut program, &router, &mut decoder);
        assert_eq!(operations.len(), 1, "origin admission must stay late");
        assert!(matches!(operations[0].value().definition(), LogicalRetainedDefinition::Source { source_id: 13, .. }));
        let error = program.finish_type_map(60, 1, [1.; 4]).unwrap_err();
        assert!(error.to_string().contains(DIAGNOSTIC), "{error}");
    }
}

#[test]
fn s2_r1_typed_numeric_scale_is_not_optional_omission() {
    for target in [
        "IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#84,IFCREAL(1.),$)",
        "IFCCARTESIANTRANSFORMATIONOPERATOR2D($,$,#84,IFCREAL(1.))",
        "IFCCARTESIANTRANSFORMATIONOPERATOR2DNONUNIFORM($,$,#84,1.,IFCREAL(1.))",
        "IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM($,$,#84,1.,$,IFCREAL(1.),1.)",
        "IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM($,$,#84,1.,$,1.,IFCREAL(1.))",
    ] { refuse(&later_target(target, ""), "Scale"); }
}

#[path = "mapping_direction_controls_tests.rs"]
mod controls;
