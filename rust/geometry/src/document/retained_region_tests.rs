// SPDX-License-Identifier: MPL-2.0
//! Round-3 source-review regressions: wire primitives must describe exact regions,
//! independently of execution qualification. These are numerical, not SDK witnesses.
use super::*;
use crate::analytic::{extract_analytic_extrusion, AnalyticStatus, SourceValue};
use ifc_lite_core::{build_entity_index, EntityDecoder};
use std::f64::consts::{PI, TAU};

fn read(profile: &str, u: f64) -> RetainedExtrusion {
    let data = format!(
        "#1=IFCCARTESIANPOINT(({},{}));\n\
#2=IFCDIRECTION((0.,2.));\n#3=IFCAXIS2PLACEMENT2D(#1,#2);\n{profile}\n\
#5=IFCCARTESIANPOINT(({},{},{}));\n\
#6=IFCDIRECTION((0.,1.,0.));\n#7=IFCDIRECTION((0.,0.,1.));\n\
#8=IFCAXIS2PLACEMENT3D(#5,#6,#7);\n#9=IFCDIRECTION((2.,1.,2.));\n\
#10=IFCEXTRUDEDAREASOLID(#4,#8,#9,{});",
        10. * u, 20. * u, 1e9 * u, 2e9 * u, 3e9 * u, 3. * u,
    );
    let mut decoder = EntityDecoder::with_index(data.as_bytes(), build_entity_index(data.as_bytes()));
    let entity = decoder.decode_by_id(10).unwrap();
    let source = extract_analytic_extrusion(&entity, &mut decoder);
    assert_eq!(source.status, AnalyticStatus::Complete);
    assert_eq!(source.profile.as_ref().unwrap().status, AnalyticStatus::Complete);
    RetainedExtrusion { source, length_unit_scale: 1. / u, source_epoch: 1, source_revision: 1 }
}
fn word(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap())
}
fn number(bytes: &[u8], at: usize) -> f64 {
    f64::from_le_bytes(bytes[at..at + 8].try_into().unwrap())
}
struct Edge { kind: u32, v: [f64; 12] }
fn decode(payload: &SweepPayload) -> Vec<Vec<Edge>> {
    assert_eq!(word(&payload.bytes, 0), 1);
    assert_eq!(word(&payload.bytes, 4), payload.loops);
    assert_eq!(word(&payload.bytes, 8), payload.segments);
    let mut offset = 48;
    let mut loops = Vec::new();
    for i in 0..payload.loops {
        assert_eq!(word(&payload.bytes, offset), u32::from(i != 0));
        let count = word(&payload.bytes, offset + 4);
        offset += 8;
        let mut edges = Vec::new();
        for _ in 0..count {
            assert_eq!(word(&payload.bytes, offset + 4), 0);
            edges.push(Edge { kind: word(&payload.bytes, offset),
                v: std::array::from_fn(|i| number(&payload.bytes, offset + 8 + 8 * i)) });
            offset += 104;
        }
        loops.push(edges);
    }
    assert_eq!(offset, payload.bytes.len());
    assert_eq!(offset, 48 + payload.loops as usize * 8 + payload.segments as usize * 104);
    loops
}
fn endpoints(edge: &Edge) -> ([f64; 2], [f64; 2]) {
    let v = edge.v;
    if edge.kind == 1 { return ([v[0], v[1]], [v[3], v[4]]); }
    let at = |t: f64| [v[0] + v[9] * (v[6] * t.cos() - v[5] * v[7] * t.sin()),
        v[1] + v[9] * (v[7] * t.cos() + v[5] * v[6] * t.sin())];
    (at(v[10]), at(v[10] + v[11]))
}
fn signed_area(edges: &[Edge]) -> f64 {
    edges.iter().map(|edge| {
        let (a, b) = endpoints(edge);
        if edge.kind == 1 { (a[0] * b[1] - a[1] * b[0]) / 2. }
        else { let v = edge.v;
            (v[0] * (b[1] - a[1]) - v[1] * (b[0] - a[0]) + v[5] * v[9].powi(2) * v[11]) / 2.
        }
    }).sum()
}
fn assert_region(payload: &SweepPayload, area: f64, volume: f64) -> Vec<Vec<Edge>> {
    let loops = decode(payload);
    for (i, edges) in loops.iter().enumerate() {
        assert_eq!(signed_area(edges).is_sign_positive(), i == 0);
        for j in 0..edges.len() {
            let (_, end) = endpoints(&edges[j]);
            let (next, _) = endpoints(&edges[(j + 1) % edges.len()]);
            assert!((end[0] - next[0]).hypot(end[1] - next[1]) < 1e-10);
        }
    }
    let measured: f64 = loops.iter().map(|edges| signed_area(edges)).sum();
    assert!((measured - area).abs() < 1e-10);
    // Independent solid invariant: area times extrusion's normal projection.
    assert!((measured * number(&payload.bytes, 40) * number(&payload.bytes, 32).abs() - volume).abs() < 1e-9);
    loops
}

#[test]
fn circle_payload_has_exact_radius_rotated_caps_and_single_metre_conversion() {
    for u in [1., 1000.] {
        let recipe = read(&format!("#4=IFCCIRCLEPROFILEDEF(.AREA.,$,#3,{});", 2. * u), u);
        let original = recipe.source.clone();
        let payload = lower(&recipe).unwrap();
        assert_eq!(payload.qualification, RegionQualification::OrderedRegion);
        assert_eq!(recipe.qualification_requirement().unwrap(), RegionQualification::OrderedRegion);
        let loops = assert_region(&payload, 4. * PI, 8. * PI);
        assert_eq!((payload.loops, payload.segments, loops[0][0].kind), (1, 1, 2));
        assert_eq!(loops[0][0].v[9], 2.);
        let (point, _) = endpoints(&loops[0][0]);
        let frame = Matrix4::from_column_slice(&payload.source_from_evaluation);
        let base = frame * Vector4::new(point[0], point[1], 0., 1.);
        let top = frame * Vector4::new(point[0] + 1., point[1] - 2., 2., 1.);
        // P rotates X to Y; S rotates profile Y to world X and X to Z.
        for i in 0..3 {
            let expected = [1e9 + 22., 2e9, 3e9 + 10.][i];
            assert!((base[i] / u - expected).abs() < 1e-6);
            assert!(((top[i] - base[i]) / u - [1., 2., 2.][i]).abs() < 1e-6);
        }
        assert_eq!(recipe.source, original);
    }
}

#[test]
fn annulus_reverses_outer_and_inner_only_in_numerical_traversal() {
    for u in [1., 1000.] {
        let recipe = read(&format!("#20=IFCCARTESIANPOINT((0.,0.));\n\
#21=IFCAXIS2PLACEMENT2D(#20,$);\n#22=IFCCIRCLE(#21,{});\n\
#23=IFCCIRCLE(#21,{});\n#24=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.F.,#22);\n\
#25=IFCCOMPOSITECURVE((#24),.F.);\n#4=IFCARBITRARYPROFILEDEFWITHVOIDS(.AREA.,$,#25,(#23));", 4. * u, u), u);
        let original = recipe.source.clone();
        let source_loops = &original.profile.as_ref().unwrap().loops;
        assert!(source_loops[0].signed_area < 0. && source_loops[1].signed_area > 0.);
        let payload = lower(&recipe).unwrap();
        let loops = assert_region(&payload, 15. * PI, 30. * PI);
        assert_eq!((payload.loops, payload.segments), (2, 2));
        assert_eq!(loops[0][0].v[11], TAU);
        assert_eq!(loops[1][0].v[11], -TAU);
        assert_eq!(recipe.source, original);
        // Replayable storage does not confer an execution capability.
        let mut document = super::super::GeometryDocument::new();
        let handle = document.add_retained_extrusion(recipe).unwrap();
        assert_eq!(document.retained_extrusion(handle).unwrap().qualification_requirement().unwrap(), RegionQualification::OrderedRegion);
    }
}

#[test]
fn polygon_with_circle_and_rectangular_holes_emits_all_ordered_boundaries() {
    let recipe = read("#20=IFCCARTESIANPOINT((-4.,-4.));\n\
#21=IFCCARTESIANPOINT((4.,-4.));\n#22=IFCCARTESIANPOINT((4.,4.));\n\
#23=IFCCARTESIANPOINT((-4.,4.));\n#24=IFCPOLYLINE((#20,#21,#22,#23,#20));\n\
#30=IFCCARTESIANPOINT((-2.,0.));\n#31=IFCAXIS2PLACEMENT2D(#30,$);\n\
#32=IFCCIRCLE(#31,0.5);\n#40=IFCCARTESIANPOINT((1.,-1.));\n\
#41=IFCCARTESIANPOINT((3.,-1.));\n#42=IFCCARTESIANPOINT((3.,1.));\n\
#43=IFCCARTESIANPOINT((1.,1.));\n#44=IFCPOLYLINE((#40,#41,#42,#43,#40));\n\
#4=IFCARBITRARYPROFILEDEFWITHVOIDS(.AREA.,$,#24,(#32,#44));", 1.);
    let payload = lower(&recipe).unwrap();
    let loops = assert_region(&payload, 60. - PI / 4., 120. - PI / 2.);
    assert_eq!((payload.loops, payload.segments), (3, 9));
    assert_eq!(loops.iter().map(Vec::len).collect::<Vec<_>>(), [4, 1, 4]);
    assert_eq!(loops[1][0].kind, 2);
    // Anchor at outer (-4,-4): the circle is independently at (2,4).
    assert_eq!(&loops[1][0].v[..3], &[2., 4., 0.]);
}

#[test]
fn mixed_trim_composite_preserves_degree_selectors_and_partial_arc_basis() {
    for u in [1., 1000.] {
        for master in ["PARAMETER", "CARTESIAN"] {
            for negative_normal in [false, true] {
              for reverse in [false, true] {
                let normal = if negative_normal { -1. } else { 1. };
                let recipe = read(&format!("#100=IFCSIUNIT(*,.LENGTHUNIT.,{length_prefix},.METRE.);\n\
#101=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);\n\
#102=IFCDIMENSIONALEXPONENTS(0,0,0,0,0,0,0);\n\
#103=IFCMEASUREWITHUNIT(IFCPLANEANGLEMEASURE(0.017453292519943295),#101);\n\
#104=IFCCONVERSIONBASEDUNIT(#102,.PLANEANGLEUNIT.,'DEGREE',#103);\n\
#105=IFCUNITASSIGNMENT((#100,#104));\n\
#106=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-9,#8,$);\n\
#107=IFCPROJECT('0Test00000000000000003',$,'Test',$,$,$,$,(#106),#105);\n\
#20=IFCCARTESIANPOINT((0.,0.,0.));\n#21=IFCDIRECTION((0.,0.,{normal}));\n\
#22=IFCDIRECTION((0.,1.,0.));\n#23=IFCAXIS2PLACEMENT3D(#20,#21,#22);\n\
#24=IFCCIRCLE(#23,{u});\n#25=IFCCARTESIANPOINT((0.,{u},0.));\n\
#26=IFCCARTESIANPOINT((0.,{},0.));\n\
#27=IFCTRIMMEDCURVE(#24,(IFCPARAMETERVALUE(0.),#25),(IFCPARAMETERVALUE(180.),#26),.T.,.{master}.);\n\
#28=IFCPOLYLINE((#26,#25));\n#29=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#27);\n\
#30=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#28);\n\
#31=IFCCOMPOSITECURVE((#29,#30),.F.);\n\
#33=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.{traversal}.,#31);\n\
#34=IFCCOMPOSITECURVE((#33),.F.);\n\
#4=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#34);", -u, traversal = if reverse { "F" } else { "T" },
                    length_prefix = if u == 1000. { ".MILLI." } else { "$" }), u);
                let original = recipe.source.clone();
                let authored_area = original.profile.as_ref().unwrap().loops[0].signed_area;
                assert_eq!(authored_area.is_sign_positive(), negative_normal == reverse);
                let payload = lower(&recipe).unwrap();
                let loops = assert_region(&payload, PI / 2., PI);
                let arc = loops[0].iter().find(|e| e.kind == 3).unwrap();
                assert_eq!(payload.segments, 2);
                assert_eq!(&arc.v[3..9], &[0., 0., normal, 0., 1., 0.]);
                assert!((arc.v[11] - normal * PI).abs() < 1e-12);
                let (a, b) = endpoints(arc);
                assert!(a[0].abs() < 1e-12 && b[0].abs() < 1e-12);
                assert!(((a[1] - arc.v[1]).abs() - 1.).abs() < 1e-12);
                assert!(((b[1] - arc.v[1]).abs() - 1.).abs() < 1e-12);
                // Independent halfway point: left half for +Z, right for -Z.
                let angle = arc.v[10] + arc.v[11] / 2.;
                let x = -arc.v[5] * angle.sin();
                assert!((x + normal).abs() < 1e-12);
                let source = original.profile.as_ref().unwrap().loops[0].source.as_ref().unwrap();
                assert!((source.plane_angle_to_radians - PI / 180.).abs() < 1e-16);
                let trim = &source.records[&27];
                assert_eq!(trim.attributes["MasterRepresentation"], SourceValue::Enum(master.into()));
                let SourceValue::List(selectors) = &trim.attributes["Trim2"] else { panic!("selectors lost") };
                assert_eq!(selectors, &vec![SourceValue::Typed { name: "IFCPARAMETERVALUE".into(),
                    value: Box::new(SourceValue::Real(180.)) }, SourceValue::EntityRef(26)]);
                assert_eq!(source.records[&33].attributes["SameSense"],
                    SourceValue::Enum(if reverse { "F" } else { "T" }.into()));
                // Both authored diameter endpoints under solid rotation, in
                // metres, independently of the parameter frame/inverse pair.
                let frame = Matrix4::from_column_slice(&payload.source_from_evaluation);
                for (x, y) in [a, b].map(|p| (p[0], p[1])) {
                    let world = frame * Vector4::new(x, y, 0., 1.);
                    assert!(((world[0] / u - 1e9).abs() - 1.).abs() < 1e-6);
                    assert!((world[1] / u - 2e9).abs() < 1e-6);
                    assert!((world[2] / u - 3e9).abs() < 1e-6);
                }
                assert_eq!(recipe.source, original);
              }
            }
        }
    }
}

#[test]
fn invalid_source_is_distinct_from_execution_qualification() {
    let valid = read("#4=IFCCIRCLEPROFILEDEF(.AREA.,$,#3,2.);", 1.);
    assert!(lower(&valid).is_ok());
    let mut missing = valid.clone();
    missing.source.profile.as_mut().unwrap().loops[0].source = None;
    assert!(matches!(lower(&missing), Err(RetainedRefusal::OriginalTrimConventionUnavailable)));
    let mut incomplete = valid.clone();
    incomplete.source.profile.as_mut().unwrap().loops[0].source.as_mut().unwrap().capture_status =
        AnalyticStatus::Unsupported("capture budget exceeded".into());
    assert!(matches!(lower(&incomplete), Err(RetainedRefusal::UnsupportedSource(_))));
    let mut invalid_basis = valid.clone();
    if let crate::analytic::AnalyticCurveSegment::Arc { normal, .. } =
        &mut invalid_basis.source.profile.as_mut().unwrap().loops[0].segments[0] { normal[2] = 2.; }
    assert!(matches!(lower(&invalid_basis), Err(RetainedRefusal::InvalidSource(_))));
    let mut wrong_role = valid.clone();
    wrong_role.source.profile.as_mut().unwrap().loops[0].kind = crate::analytic::ProfileLoopKind::Inner;
    assert!(matches!(lower(&wrong_role), Err(RetainedRefusal::InvalidSource(_))));
    let mut over_budget = valid.clone();
    let boundary = over_budget.source.profile.as_ref().unwrap().loops[0].clone();
    over_budget.source.profile.as_mut().unwrap().loops = vec![boundary; 129];
    assert!(matches!(lower(&over_budget), Err(RetainedRefusal::InvalidSource(_))));
    let mut discontinuous = super::tests::recipe(1.);
    if let crate::analytic::AnalyticCurveSegment::Line { end, .. } =
        &mut discontinuous.source.profile.as_mut().unwrap().loops[0].segments[0] { end[0] += 0.1; }
    assert!(matches!(lower(&discontinuous), Err(RetainedRefusal::InvalidSource(_))));
}
