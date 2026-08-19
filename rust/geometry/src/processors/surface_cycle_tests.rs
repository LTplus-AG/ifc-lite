// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;
use ifc_lite_core::EntityDecoder;

fn wrap(data: &str) -> String {
    format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\n\
FILE_NAME('t.ifc','2024-01-01T00:00:00',(''),(''),'','','');\n\
FILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n{data}ENDSEC;\nEND-ISO-10303-21;\n"
    )
}

fn profile_points(data: &str, id: u32) -> Vec<Point2<f64>> {
    let content = wrap(data);
    let mut decoder = EntityDecoder::new(&content);
    SurfaceOfLinearExtrusionProcessor::get_profile_curve_points(id, &mut decoder)
        .expect("profile points")
}

/// A well-formed composite-curve profile: one segment whose ParentCurve is a
/// 3-point IfcPolyline. Before the fix this returned `Ok(vec![])` — the
/// ParentCurve was routed through the PROFILE entry point, which read
/// attribute 2 of the polyline as "the profile's curve", found none, errored,
/// and had the error swallowed by `if let Ok(..)`. No points, no error, and
/// indistinguishable from a legitimately empty profile.
const WELLFORMED: &str = "#10=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#20);\n\
#20=IFCCOMPOSITECURVE((#21),.F.);\n\
#21=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#22);\n\
#22=IFCPOLYLINE((#23,#24,#25));\n\
#23=IFCCARTESIANPOINT((0.,0.));\n\
#24=IFCCARTESIANPOINT((1.,0.));\n\
#25=IFCCARTESIANPOINT((1.,1.));\n";

#[test]
fn a_composite_curve_profile_yields_its_segment_points() {
    let pts = profile_points(WELLFORMED, 10);
    assert_eq!(
        pts.len(),
        3,
        "a composite profile with one 3-point polyline segment must yield 3 points, got {}",
        pts.len()
    );
    assert_eq!(pts[0], Point2::new(0.0, 0.0));
    assert_eq!(pts[2], Point2::new(1.0, 1.0));
}

/// Two segments, so the joint-dedup path is exercised: the second segment's
/// first point is skipped, giving 3 + 3 - 1 = 5.
#[test]
fn two_segments_join_without_duplicating_the_seam() {
    let data = "#10=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#20);\n\
#20=IFCCOMPOSITECURVE((#21,#31),.F.);\n\
#21=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#22);\n\
#22=IFCPOLYLINE((#23,#24,#25));\n\
#23=IFCCARTESIANPOINT((0.,0.));\n\
#24=IFCCARTESIANPOINT((1.,0.));\n\
#25=IFCCARTESIANPOINT((1.,1.));\n\
#31=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#32);\n\
#32=IFCPOLYLINE((#33,#34,#35));\n\
#33=IFCCARTESIANPOINT((1.,1.));\n\
#34=IFCCARTESIANPOINT((2.,1.));\n\
#35=IFCCARTESIANPOINT((2.,2.));\n";
    assert_eq!(profile_points(data, 10).len(), 5);
}

/// The cycle the visited set actually guards: a composite curve whose segment
/// `ParentCurve` is that same composite curve. `curve_points_guarded` re-enters
/// itself directly, so nothing structural stops it.
///
/// Note the shape here was chosen by mutation, not by guesswork. The obvious
/// fixture — the ParentCurve pointing back at the PROFILE — is broken by the
/// curve/profile split alone, so it stayed green with the visited set removed
/// and would have shipped a guard no test defended.
#[test]
fn self_referential_composite_curve_terminates() {
    let data = "#10=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#20);\n\
#20=IFCCOMPOSITECURVE((#21),.F.);\n\
#21=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#20);\n";
    assert!(profile_points(data, 10).is_empty());
}

/// A two-node curve cycle: `#20`'s segment parents `#30`, whose segment
/// parents `#20`. Not catchable by comparing an id against its immediate
/// parent.
#[test]
fn two_node_composite_curve_cycle_terminates() {
    let data = "#10=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#20);\n\
#20=IFCCOMPOSITECURVE((#21),.F.);\n\
#21=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#30);\n\
#30=IFCCOMPOSITECURVE((#31),.F.);\n\
#31=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#20);\n";
    assert!(profile_points(data, 10).is_empty());
}

/// Fan-out: four segments each re-entering the same composite curve. A depth
/// cap bounds the chain's length and not its breadth, so this costs
/// `O(4^depth)` without the set — an abort traded for a hang.
#[test]
fn cyclic_composite_curve_with_fan_out_terminates() {
    let data = "#10=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#20);\n\
#20=IFCCOMPOSITECURVE((#21,#22,#23,#24),.F.);\n\
#21=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#20);\n\
#22=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#20);\n\
#23=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#20);\n\
#24=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#20);\n";
    assert!(profile_points(data, 10).is_empty());
}

/// And the original shape kept as a regression on the SPLIT: a ParentCurve
/// pointing at the profile must not re-enter the profile path.
#[test]
fn parent_curve_pointing_at_a_profile_terminates() {
    let data = "#10=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#20);\n\
#20=IFCCOMPOSITECURVE((#21),.F.);\n\
#21=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#10);\n";
    assert!(profile_points(data, 10).is_empty());
}
