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

/// A long ACYCLIC nesting chain: each composite curve's segment parents the
/// NEXT composite curve, every id distinct, so every `visited.insert` succeeds
/// and the set never fires. Before the depth cap this aborted the process on
/// stack depth alone, with no cycle in the file (Codex, #2871/#2872 review).
#[test]
fn a_long_acyclic_curve_chain_terminates() {
    let n: u32 = 3_000;
    let mut data = String::from("#1=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#100);\n");
    for i in 0..n {
        let cc = 100 + i * 2;
        let seg = 101 + i * 2;
        let next = if i + 1 == n { 90000 } else { 100 + (i + 1) * 2 };
        data.push_str(&format!("#{cc}=IFCCOMPOSITECURVE((#{seg}),.F.);\n"));
        data.push_str(&format!(
            "#{seg}=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#{next});\n"
        ));
    }
    data.push_str("#90000=IFCPOLYLINE((#90001,#90002));\n");
    data.push_str("#90001=IFCCARTESIANPOINT((0.,0.));\n");
    data.push_str("#90002=IFCCARTESIANPOINT((1.,0.));\n");
    // Asserting the RESULT, not merely that it returned: the polyline sits
    // 3,000 links down, well past the cap, so nothing survives from beyond it.
    // "it did not crash" would also be satisfied by a guard that broke the
    // well-formed case, which the tests above cover in the other direction.
    assert!(profile_points(&data, 1).is_empty());
}

/// A ParentCurve legitimately REUSED by two segments must be sampled both
/// times. A global visited set makes the second occurrence return empty —
/// which is not "already computed", it is the wrong value, and the caller
/// accumulates, so the profile silently comes up short. (Codex + CodeRabbit,
/// #2874 review.)
#[test]
fn a_reused_parent_curve_contributes_to_every_segment() {
    let data = "#10=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#20);\n\
#20=IFCCOMPOSITECURVE((#21,#31),.F.);\n\
#21=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#22);\n\
#31=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#22);\n\
#22=IFCPOLYLINE((#23,#24,#25));\n\
#23=IFCCARTESIANPOINT((0.,0.));\n\
#24=IFCCARTESIANPOINT((1.,0.));\n\
#25=IFCCARTESIANPOINT((1.,1.));\n";
    // Both occurrences sample; the seam between them does NOT coincide
    // ((1,1) then (0,0)), so nothing is dropped: 3 + 3 = 6.
    assert_eq!(profile_points(data, 10).len(), 6);
}

/// `SameSense = .F.` means the segment traverses its ParentCurve BACKWARDS.
/// Nothing applied it before, because no segment ever produced points to
/// orient — every one came back empty, so a reversed segment and a forward one
/// were indistinguishable. (Codex, #2874 review.)
#[test]
fn same_sense_false_reverses_the_segment() {
    let data = "#10=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#20);\n\
#20=IFCCOMPOSITECURVE((#21),.F.);\n\
#21=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.F.,#22);\n\
#22=IFCPOLYLINE((#23,#24,#25));\n\
#23=IFCCARTESIANPOINT((0.,0.));\n\
#24=IFCCARTESIANPOINT((1.,0.));\n\
#25=IFCCARTESIANPOINT((1.,1.));\n";
    let pts = profile_points(data, 10);
    assert_eq!(pts.len(), 3);
    assert_eq!(pts[0], Point2::new(1.0, 1.0), "reversed: last authored point first");
    assert_eq!(pts[2], Point2::new(0.0, 0.0));
}

/// The seam point is dropped only when it actually duplicates. Two segments
/// that do NOT meet — a gap, or a `.DISCONTINUOUS.` transition — must keep
/// every point; an unconditional skip ate one. (Codex, #2874 review.)
#[test]
fn a_discontinuous_joint_keeps_both_endpoints() {
    let data = "#10=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#20);\n\
#20=IFCCOMPOSITECURVE((#21,#31),.F.);\n\
#21=IFCCOMPOSITECURVESEGMENT(.DISCONTINUOUS.,.T.,#22);\n\
#22=IFCPOLYLINE((#23,#24));\n\
#23=IFCCARTESIANPOINT((0.,0.));\n\
#24=IFCCARTESIANPOINT((1.,0.));\n\
#31=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#32);\n\
#32=IFCPOLYLINE((#33,#34));\n\
#33=IFCCARTESIANPOINT((5.,5.));\n\
#34=IFCCARTESIANPOINT((6.,5.));\n";
    let pts = profile_points(data, 10);
    assert_eq!(pts.len(), 4, "the joint does not coincide, so no point is dropped");
    assert_eq!(pts[2], Point2::new(5.0, 5.0));
}

/// Build an ACYCLIC composite-curve DAG: two segments per level, both pointing
/// at the next level, terminating in a real polyline. Nothing is cyclic and
/// nothing fails, so neither the path-scoped `seen` set nor the depth cap can
/// see it — and the work doubles per level.
fn dag_data(levels: u32) -> String {
    let mut d = String::from("#1=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#10);\n");
    for i in 0..levels {
        let cc = 10 + i;
        let next = if i + 1 == levels { 9000 } else { 10 + i + 1 };
        let (s1, s2) = (1000 + i * 2, 1001 + i * 2);
        d.push_str(&format!("#{cc}=IFCCOMPOSITECURVE((#{s1},#{s2}),.F.);\n"));
        d.push_str(&format!("#{s1}=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#{next});\n"));
        d.push_str(&format!("#{s2}=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#{next});\n"));
    }
    d.push_str("#9000=IFCPOLYLINE((#9001,#9002));\n");
    d.push_str("#9001=IFCCARTESIANPOINT((0.,0.));\n");
    d.push_str("#9002=IFCCARTESIANPOINT((1.,0.));\n");
    d
}

/// Positive control: a modest DAG must still resolve completely, or the budget
/// is just breaking valid files.
#[test]
fn a_modest_acyclic_dag_still_resolves_completely() {
    let content = wrap(&dag_data(8));
    let mut decoder = EntityDecoder::new(&content);
    let item = decoder.decode_by_id(1).expect("decode profile");
    let pts = SurfaceOfLinearExtrusionProcessor::get_profile_curve_points(item.id, &mut decoder)
        .expect("8 levels must resolve");
    assert!(pts.len() > 100, "expected the full expansion, got {}", pts.len());
}

/// The bound. 30 levels is 2^30 curve visits under a depth cap alone —
/// measured before the budget at 2^levels points (levels=16 gave 131,072).
/// Asserted on the ERROR, not on elapsed time: a timing assertion after the
/// call cannot fire when the call does not return.
#[test]
fn a_wide_acyclic_dag_is_bounded_by_the_node_budget() {
    let content = wrap(&dag_data(30));
    let mut decoder = EntityDecoder::new(&content);
    let item = decoder.decode_by_id(1).expect("decode profile");
    let err = SurfaceOfLinearExtrusionProcessor::get_profile_curve_points(item.id, &mut decoder)
        .expect_err("a 2^30 traversal must be refused, not attempted");
    assert!(
        err.to_string().contains("exceeded"),
        "the node budget must be what stops it, got: {err}"
    );
}

/// The budget's boundary, both sides. `budget == 0` is true after the last
/// PERMITTED visit as well as after a refused one, so re-raising on it would
/// fail a traversal that used exactly `MAX_CURVE_NODES` visits and exceeded
/// nothing. `exhausted` is set only by an attempted charge with nothing left.
/// (CodeRabbit, #2874 review — a valid-but-boundary false positive.)
#[test]
fn exactly_max_curve_nodes_visits_is_not_exhaustion() {
    let mut walk = CurveWalk::new();
    for i in 0..MAX_CURVE_NODES {
        walk.spend()
            .unwrap_or_else(|e| panic!("visit {i} of {MAX_CURVE_NODES} must be permitted: {e}"));
    }
    assert_eq!(walk.budget, 0, "the budget is spent to the last unit");
    assert!(
        !walk.exhausted,
        "spending the budget exactly is not exhaustion"
    );

    // One past is.
    assert!(walk.spend().is_err(), "the next visit must be refused");
    assert!(walk.exhausted, "and it must record that it refused one");
}

/// The same boundary through the CALLER, which is where the off-by-one lived.
/// One composite curve plus `MAX_CURVE_NODES - 1` segments all parenting the
/// same polyline is exactly `MAX_CURVE_NODES` visits: the budget lands on zero
/// having refused nothing, so the profile must come back complete.
///
/// The unit test above cannot catch this — it pins `spend`, and the defect was
/// the caller re-raising on `budget == 0` rather than on a refusal.
#[test]
fn a_traversal_of_exactly_the_budget_still_returns_its_profile() {
    let segs = MAX_CURVE_NODES - 1;
    let mut d = String::with_capacity(segs as usize * 60);
    // Segment ids start well above the polyline's, or they collide: at
    // 1000 + i, segment 8000 would BE #9000.
    let refs: Vec<String> = (0..segs).map(|i| format!("#{}", 500_000 + i)).collect();
    d.push_str("#1=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#10);\n");
    d.push_str(&format!("#10=IFCCOMPOSITECURVE(({}),.F.);\n", refs.join(",")));
    for i in 0..segs {
        d.push_str(&format!(
            "#{}=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#9000);\n",
            500_000 + i
        ));
    }
    d.push_str("#9000=IFCPOLYLINE((#9001,#9002));\n");
    d.push_str("#9001=IFCCARTESIANPOINT((0.,0.));\n");
    d.push_str("#9002=IFCCARTESIANPOINT((1.,0.));\n");

    let content = wrap(&d);
    let mut decoder = EntityDecoder::new(&content);
    let item = decoder.decode_by_id(1).expect("decode profile");
    let pts = SurfaceOfLinearExtrusionProcessor::get_profile_curve_points(item.id, &mut decoder)
        .expect("a traversal that spends the budget exactly must not be refused");
    assert!(!pts.is_empty(), "and it must return its points");
}
