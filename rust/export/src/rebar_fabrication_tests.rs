// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;
use crate::rebar_schedule::build_rebar_schedule_with_fabrication_precheck;
use ifc_lite_processing::SweptDiskCheckOptions;

const U_BAR: &str = include_str!("../../geometry/tests/fixtures/swept_disk_composite_arc_ubar.ifc");
const L_BAR: &str = include_str!("../../geometry/tests/fixtures/swept_disk_composite_arc_lbar.ifc");
const CRANK: &str = include_str!("../../geometry/tests/fixtures/swept_disk_composite_arc_crankbar.ifc");
const MAPPED: &str = include_str!("../../geometry/tests/fixtures/swept_disk_trimmed_line.ifc");

fn schedule(ifc: &str, policy: RebarFabricationPolicy) -> crate::rebar_schedule::RebarSchedule {
    build_rebar_schedule_with_fabrication_precheck(
        ifc.as_bytes(), None, &SweptDiskCheckOptions::default(), &policy,
    ).unwrap()
}

fn full_policy() -> RebarFabricationPolicy {
    RebarFabricationPolicy {
        min_inside_bend_radius_m: Some(0.08),
        min_straight_segment_length_m: Some(0.1),
        allowed_bend_angle_rad: Some([0.0, std::f64::consts::PI]),
        max_nominal_geometric_diameter_delta_m: Some(0.001),
        max_developed_centreline_length_m: Some(100.0),
    }
}

#[test]
fn issue_5797_optional_policy_reports_arc_and_straight_provenance() {
    let view = schedule(U_BAR, full_policy());
    let row = &view.rows[&125];
    let report = row.sweeps[0].fabrication_precheck.as_ref().unwrap();
    assert_eq!(report.outcome, "precheck_only");
    assert!(report.unchecked_factors.contains(&"physical_bar_count"));
    assert!(report.checks.iter().any(|check| check.kind == "inside_bend_radius"
        && check.segment_index.is_some() && check.measured.is_some()));
    assert!(report.checks.iter().any(|check| check.kind == "bend_angle"
        && check.segment_index.is_some() && check.units == "rad"));
    assert!(report.checks.iter().any(|check| check.kind == "straight_segment_length"
        && check.segment_index.is_some()));
    assert!(report.checks.iter().any(|check| check.kind == "nominal_geometric_diameter_delta"
        && check.authored_source_id == Some(125)
        && check.nominal_diameter_m.is_some()));
    assert!(schedule(CRANK, full_policy()).rows[&79].sweeps[0]
        .fabrication_precheck.as_ref().unwrap().checks.iter()
        .any(|check| check.kind == "bend_angle"
            && check.measured.is_some_and(|angle| (angle - 0.08227).abs() < 1e-5)
            && check.status == RebarFabricationCheckStatus::Pass));
    assert!(schedule(L_BAR, full_policy()).rows[&78].sweeps[0]
        .fabrication_precheck.as_ref().unwrap().checks.iter()
        .any(|check| check.kind == "bend_angle" && check.segment_index == Some(1)
            && check.measured.is_some_and(|angle| (angle - std::f64::consts::FRAC_PI_2).abs() < 1e-12)
            && check.status == RebarFabricationCheckStatus::Pass));
}

#[test]
fn issue_5797_modified_and_unsupported_sources_cannot_pass_geometry() {
    let modified = MAPPED.replace(
        "#44=IFCSHAPEREPRESENTATION(#16,'Body','AdvancedSweptSolid',(#43));",
        "#1001=IFCBOOLEANRESULT(.UNION.,#43,#43);\n#44=IFCSHAPEREPRESENTATION(#16,'Body','AdvancedSweptSolid',(#1001));",
    );
    let view = schedule(&modified, full_policy());
    let reports = view.rows[&50].sweeps.iter().map(|sweep| sweep.fabrication_precheck.as_ref().unwrap());
    for report in reports {
        assert!(report.source_modified);
        assert!(report.checks.iter().all(|check| check.status == RebarFabricationCheckStatus::Uncheckable));
    }
    let unsupported = MAPPED.replace(
        "#46=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#10,$,$);",
        "#46=IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM($,$,#10,$,$,2.,1.);",
    );
    let report = schedule(&unsupported, full_policy()).rows[&50].sweeps[0]
        .fabrication_precheck.clone().unwrap();
    assert!(report.checks.iter().all(|check| check.status == RebarFabricationCheckStatus::Uncheckable));
    assert!(report.limitations.iter().any(|reason| reason.contains("unsupported")));
}

#[test]
fn issue_5797_policy_rejected_before_ifc_decode() {
    for bad in [f64::NAN, f64::INFINITY, -1.0] {
        let policy = RebarFabricationPolicy { min_inside_bend_radius_m: Some(bad), ..full_policy() };
        assert!(matches!(build_rebar_schedule_with_fabrication_precheck(
            b"not IFC", None, &SweptDiskCheckOptions::default(), &policy,
        ), Err(RebarScheduleFabricationError::Policy(error)) if error.option == "min_inside_bend_radius_m"));
    }
    for range in [[2.0, 1.0], [-0.1, 1.0]] {
        let policy = RebarFabricationPolicy { allowed_bend_angle_rad: Some(range), ..full_policy() };
        assert!(policy.validate().is_err());
    }
}

#[test]
fn issue_5797_diameter_missing_invalid_mismatch_and_type_conflict() {
    let policy = RebarFabricationPolicy {
        max_nominal_geometric_diameter_delta_m: Some(0.001),
        ..RebarFabricationPolicy::default()
    };
    let check_for = |source: &str| schedule(source, policy).rows[&125].sweeps[0]
        .fabrication_precheck.as_ref().unwrap().checks[0].clone();
    let missing = U_BAR.replace("#33,#124,$,$,29.,", "#33,#124,$,$,$,");
    let check = check_for(&missing);
    assert_eq!(check.status, RebarFabricationCheckStatus::Uncheckable);
    assert!(check.reason.unwrap().contains("NominalDiameter"));
    let invalid = U_BAR.replace("#33,#124,$,$,29.,", "#33,#124,$,$,-1.,");
    assert_eq!(check_for(&invalid).status, RebarFabricationCheckStatus::Uncheckable);
    let mismatch = U_BAR.replace("#33,#124,$,$,29.,", "#33,#124,$,$,100.,");
    let check = check_for(&mismatch);
    assert_eq!(check.status, RebarFabricationCheckStatus::Fail);
    assert!(check.reason.unwrap().contains("maximum"));
    let conflict = U_BAR.replace("FILE_SCHEMA(('IFC2X3'))", "FILE_SCHEMA(('IFC4'))").replace(
        "ENDSEC;\nEND-ISO-10303-21;",
        "#9000=IFCREINFORCINGBARTYPE('type',$,'Type',$,$,$,$,$,$,.SHEAR.,32.,$,800.,$,'S1',$);\n\
         #9001=IFCRELDEFINESBYTYPE('rel',$,$,$,(#125),#9000);\n\
         ENDSEC;\nEND-ISO-10303-21;",
    );
    let check = check_for(&conflict);
    assert_eq!(check.status, RebarFabricationCheckStatus::Uncheckable);
    assert!(check.reason.unwrap().contains("ambiguous"));
    let second_type = conflict.replace(
        "#9001=IFCRELDEFINESBYTYPE('rel',$,$,$,(#125),#9000);",
        "#9001=IFCRELDEFINESBYTYPE('rel',$,$,$,(#125),#9000);\n\
         #9002=IFCREINFORCINGBARTYPE('type2',$,'Type 2',$,$,$,$,$,$,.SHEAR.,29.,$,800.,$,'S2',$);\n\
         #9003=IFCRELDEFINESBYTYPE('rel2',$,$,$,(#125),#9002);",
    );
    let report = schedule(&second_type, policy).rows[&125].sweeps[0]
        .fabrication_precheck.clone().unwrap();
    assert!(report.limitations.iter().any(|reason| reason == "conflicting type assignments"));
}

#[test]
fn issue_5797_mapped_scaled_and_mirrored_source_visibility() {
    let policy = RebarFabricationPolicy {
        min_straight_segment_length_m: Some(1.0),
        max_nominal_geometric_diameter_delta_m: Some(0.001),
        ..RebarFabricationPolicy::default()
    };
    for (transform, expected_length, expected_diameter_status) in [
        ("#46=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#10,2.,$);", 5.5, RebarFabricationCheckStatus::Fail),
        ("#46=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#10,-1.,$);", 2.75, RebarFabricationCheckStatus::Pass),
    ] {
        let source = MAPPED.replace("#46=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#10,$,$);", transform);
        let report = schedule(&source, policy).rows[&50].sweeps[0]
            .fabrication_precheck.clone().unwrap();
        assert!(!report.mapping_path.is_empty());
        assert!(report.limitations.iter().any(|reason| reason.contains("mapped")));
        assert!(report.checks.iter().any(|check| check.kind == "straight_segment_length"
            && check.measured.is_some_and(|length| (length - expected_length).abs() < 1e-12)
            && check.status == RebarFabricationCheckStatus::Pass));
        assert!(report.checks.iter().any(|check| check.kind == "nominal_geometric_diameter_delta"
            && check.status == expected_diameter_status));
    }
}

#[test]
fn issue_5797_revit_source_measurement_is_not_certification() {
    let Some(content) = crate::test_support::fixture_opt(
        "various/01_Snowdon_Towers_Sample_Structural(1).ifc",
    ) else { return };
    let policy = RebarFabricationPolicy {
        min_inside_bend_radius_m: Some(0.05),
        max_nominal_geometric_diameter_delta_m: Some(0.0001),
        ..RebarFabricationPolicy::default()
    };
    let view = build_rebar_schedule_with_fabrication_precheck(
        &content, None, &SweptDiskCheckOptions::default(), &policy,
    ).unwrap();
    let row = &view.rows[&132347];
    let sweep = row.sweeps.iter().find(|sweep| sweep.solid_id == 132340).unwrap();
    let report = sweep.fabrication_precheck.as_ref().unwrap();
    let diameter = report.checks.iter().find(|check| check.kind == "nominal_geometric_diameter_delta").unwrap();
    assert_eq!(diameter.authored_source_id, Some(132347));
    assert_eq!(diameter.status, RebarFabricationCheckStatus::Pass);
    assert!((diameter.nominal_diameter_m.unwrap() - 0.01905).abs() < 1e-8);
    assert!((diameter.geometric_diameter_m.unwrap() - 0.01905).abs() < 1e-8);
    assert!(report.checks.iter().any(|check| check.kind == "inside_bend_radius"
        && check.measured.is_some_and(|value| (value - 0.05715).abs() < 1e-8)));
    assert_eq!(report.outcome, "precheck_only");
    assert!(report.unchecked_factors.contains(&"physical_bar_count"));
}
