//! Regression test for the W410x60 (and any Revit wide-flange) profile-area
//! calibration failure documented in the geometry-correctness calibration
//! report: 6 instances of `M_W-Wide Flange:W410X60` in duplex.ifc produced a
//! deterministic `volume_ratio = 1.0431` vs IfcOpenShell, identical to four
//! decimal places across every instance.
//!
//! Root cause: Revit authors W-section beams as
//! `IfcArbitraryClosedProfileDef` whose `IfcCompositeCurve` mixes polyline
//! edges (the flange/web straight runs) with `IfcTrimmedCurve` arcs (the
//! flange-to-web fillets). The over-tessellated-curve detector in
//! `simplify_smooth_curve_polyline` keyed off `mean_edge / diagonal`, which
//! reads small for this mixed polygon because the dozens of short fillet-arc
//! sampling edges drag the mean down. RDP then ran, dropped the polyline
//! corner vertices that anchor the fillet endpoints, and the polygon bulged
//! outward across the web-flange transition — adding ~4.3% to the swept
//! volume.
//!
//! Fix: require uniform edge length (no single edge larger than
//! `SMOOTH_CURVE_LONGEST_EDGE_RATIO` of the diagonal) before simplifying.
//! Round-window fixtures (issue #635) still simplify; mixed-geometry
//! profiles are left untouched.

use ifc_lite_core::{EntityDecoder, IfcSchema};
use ifc_lite_geometry::ProfileProcessor;
use nalgebra::Point2;

fn shoelace_area(points: &[Point2<f64>]) -> f64 {
    let n = points.len();
    if n < 3 {
        return 0.0;
    }
    let mut s = 0.0;
    for i in 0..n {
        let p = points[i];
        let q = points[(i + 1) % n];
        s += p.x * q.y - q.x * p.y;
    }
    s.abs() / 2.0
}

#[test]
fn w410x60_arbitrary_closed_profile_with_fillet_arcs_matches_analytical_area() {
    // Profile lifted verbatim from duplex.ifc beam #36892 (one of six
    // W410x60 beams sharing the same profile type).
    let content = r#"
#11=IFCDIRECTION((1.,0.));
#12=IFCDIRECTION((-1.,0.));
#13=IFCDIRECTION((0.,1.));
#14=IFCDIRECTION((0.,-1.));
#36815=IFCCARTESIANPOINT((-0.08900000000000359,-0.1907));
#36816=IFCCARTESIANPOINT((-0.08900000000000359,-0.2035000000000003));
#36817=IFCPOLYLINE((#36815,#36816));
#36818=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#36817);
#36819=IFCCARTESIANPOINT((-0.08900000000000359,-0.2035000000000003));
#36820=IFCCARTESIANPOINT((0.0889999999999971,-0.2035000000000003));
#36821=IFCPOLYLINE((#36819,#36820));
#36822=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#36821);
#36823=IFCCARTESIANPOINT((0.0889999999999971,-0.2035000000000003));
#36824=IFCCARTESIANPOINT((0.0889999999999971,-0.1907));
#36825=IFCPOLYLINE((#36823,#36824));
#36826=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#36825);
#36827=IFCCARTESIANPOINT((0.0889999999999971,-0.1907));
#36828=IFCCARTESIANPOINT((0.02104999999999522,-0.1907));
#36829=IFCPOLYLINE((#36827,#36828));
#36830=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#36829);
#36831=IFCCARTESIANPOINT((0.02104999999999522,-0.1734999999999995));
#36832=IFCAXIS2PLACEMENT2D(#36831,#14);
#36833=IFCCIRCLE(#36832,0.0172);
#36834=IFCTRIMMEDCURVE(#36833,(IFCPARAMETERVALUE(269.9999999999999)),(IFCPARAMETERVALUE(359.9999999999997)),.T.,.PARAMETER.);
#36835=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.F.,#36834);
#36836=IFCCARTESIANPOINT((0.003849999999996959,-0.1734999999999995));
#36837=IFCCARTESIANPOINT((0.003849999999996959,0.1735000000000001));
#36838=IFCPOLYLINE((#36836,#36837));
#36839=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#36838);
#36840=IFCCARTESIANPOINT((0.02104999999999522,0.1735000000000001));
#36841=IFCAXIS2PLACEMENT2D(#36840,#12);
#36842=IFCCIRCLE(#36841,0.0172);
#36843=IFCTRIMMEDCURVE(#36842,(IFCPARAMETERVALUE(269.9999999999999)),(IFCPARAMETERVALUE(359.9999999999999)),.T.,.PARAMETER.);
#36844=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.F.,#36843);
#36845=IFCCARTESIANPOINT((0.02104999999999522,0.1907));
#36846=IFCCARTESIANPOINT((0.0889999999999971,0.1907));
#36847=IFCPOLYLINE((#36845,#36846));
#36848=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#36847);
#36849=IFCCARTESIANPOINT((0.0889999999999971,0.1907));
#36850=IFCCARTESIANPOINT((0.0889999999999971,0.2034999999999992));
#36851=IFCPOLYLINE((#36849,#36850));
#36852=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#36851);
#36853=IFCCARTESIANPOINT((0.0889999999999971,0.2034999999999992));
#36854=IFCCARTESIANPOINT((-0.08900000000000359,0.2034999999999992));
#36855=IFCPOLYLINE((#36853,#36854));
#36856=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#36855);
#36857=IFCCARTESIANPOINT((-0.08900000000000359,0.2034999999999992));
#36858=IFCCARTESIANPOINT((-0.08900000000000359,0.1907));
#36859=IFCPOLYLINE((#36857,#36858));
#36860=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#36859);
#36861=IFCCARTESIANPOINT((-0.08900000000000359,0.1907));
#36862=IFCCARTESIANPOINT((-0.02105000000000388,0.1907));
#36863=IFCPOLYLINE((#36861,#36862));
#36864=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#36863);
#36865=IFCCARTESIANPOINT((-0.02105000000000604,0.1735000000000001));
#36866=IFCAXIS2PLACEMENT2D(#36865,#13);
#36867=IFCCIRCLE(#36866,0.0172);
#36868=IFCTRIMMEDCURVE(#36867,(IFCPARAMETERVALUE(269.9999999999999)),(IFCPARAMETERVALUE(0.)),.T.,.PARAMETER.);
#36869=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.F.,#36868);
#36870=IFCCARTESIANPOINT((-0.003850000000003457,0.1735000000000001));
#36871=IFCCARTESIANPOINT((-0.003850000000003457,-0.1734999999999995));
#36872=IFCPOLYLINE((#36870,#36871));
#36873=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#36872);
#36874=IFCCARTESIANPOINT((-0.02105000000000604,-0.1734999999999995));
#36875=IFCAXIS2PLACEMENT2D(#36874,#11);
#36876=IFCCIRCLE(#36875,0.0172);
#36877=IFCTRIMMEDCURVE(#36876,(IFCPARAMETERVALUE(269.9999999999999)),(IFCPARAMETERVALUE(5.088887490341632E-014)),.T.,.PARAMETER.);
#36878=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.F.,#36877);
#36879=IFCCARTESIANPOINT((-0.02105000000000388,-0.1907));
#36880=IFCCARTESIANPOINT((-0.08900000000000359,-0.1907));
#36881=IFCPOLYLINE((#36879,#36880));
#36882=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#36881);
#36883=IFCCOMPOSITECURVE((#36818,#36822,#36826,#36830,#36835,#36839,#36844,#36848,#36852,#36856,#36860,#36864,#36869,#36873,#36878,#36882),.F.);
#36884=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#36883);
"#;

    let mut decoder = EntityDecoder::new(content);
    let schema = IfcSchema::new();
    let processor = ProfileProcessor::new(schema);

    let profile_entity = decoder.decode_by_id(36884).expect("decode profile");
    let profile = processor
        .process(&profile_entity, &mut decoder)
        .expect("process profile");

    let area = shoelace_area(&profile.outer);

    // Analytical reference. Dimensions come straight from the IFC entity
    // graph above; see attribute coordinates in the profile body.
    //   overall width   bf = 0.178 m
    //   overall depth   h  = 0.407 m
    //   flange thickness tf = 0.0128 m  (= 0.2035 − 0.1907)
    //   web thickness   tw = 0.0077 m  (= 2 × 0.003849…)
    //   fillet radius   r  = 0.0172 m
    let bf = 0.178_f64;
    let h = 0.407_f64;
    let tf = 0.0128_f64;
    let tw = 0.0077_f64;
    let r = 0.0172_f64;
    let simple = 2.0 * bf * tf + (h - 2.0 * tf) * tw;
    let analytical_with_fillets = simple + 4.0 * r * r * (1.0 - std::f64::consts::PI / 4.0);

    // Pre-fix, this ratio was ~1.0442. The fix must keep it ≤ 1.005 — any
    // larger means `simplify_smooth_curve_polyline` is mangling the
    // polyline-plus-fillet polygon again. The 0.5% upper bound leaves
    // headroom for arc-sampling error (9 segments per 90° = ~0.07% area
    // overshoot) while catching any regression that re-enables the RDP
    // pass on mixed-geometry profiles.
    let ratio = area / analytical_with_fillets;
    assert!(
        ratio < 1.005,
        "W410x60 profile area {} exceeds analytical with-fillets area {} by more than 0.5% (ratio = {:.6}). \
         This is the calibration-report defect — `simplify_smooth_curve_polyline` is dropping polyline corners \
         adjacent to fillet arcs.",
        area,
        analytical_with_fillets,
        ratio
    );
    // Sanity floor: the polygon must at least cover the simple I outline.
    assert!(
        ratio > 0.99,
        "W410x60 profile area {} is below analytical with-fillets area {} (ratio = {:.6}). \
         Suggests fillet arcs are being skipped or reversed.",
        area,
        analytical_with_fillets,
        ratio
    );
}
