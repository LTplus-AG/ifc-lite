// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! #7955: dental_clinic #2510's curved mullion profile (composite curve
//! #162646, Revit degrees), extruded 150 mm. At chord 1 mm the pinned SDK
//! tessellates its inner arc with 8 segments and its outer arc with 16, which
//! publishes +0.68% volume. Scaled by 0.9 both arcs get 8 and it publishes.
use ifc_lite_core::SourceBundle;
use ifc_lite_processing::element::retained_runtime::{ModelOptions, ProductOutcome};
#[allow(dead_code)]
#[path = "../examples/compare/metrics.rs"]
mod metrics;
fn worker() -> Option<std::ffi::OsString> {
    let path = std::env::var_os("IFCLITE_SMLIB_WORKER");
    if path.is_none() {
        assert!(std::env::var_os("IFCLITE_REQUIRE_SMLIB").is_none(), "real SMLib SDK required");
        eprintln!("SKIP chordal native: set IFCLITE_SMLIB_WORKER; not SDK evidence");
    }
    path
}
/// Exact profile area of #162646 (Green's theorem on the authored curve).
const AREA: f64 = 0.06625402363931;
const DEPTH: f64 = 0.15;
fn mullion(k: f64) -> String {
    let p = |x: f64, y: f64| format!("({:?},{:?})", x * k, y * k);
    format!("ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;
#1=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);#2=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);
#3=IFCDIMENSIONALEXPONENTS(0,0,0,0,0,0,0);#4=IFCMEASUREWITHUNIT(IFCRATIOMEASURE(0.01745329251994328),#2);
#5=IFCCONVERSIONBASEDUNIT(#3,.PLANEANGLEUNIT.,'DEGREE',#4);#6=IFCUNITASSIGNMENT((#1,#5));
#7=IFCPROJECT('0000000000000000000000',$,'SYNTHETIC',$,$,$,$,$,#6);
#10=IFCCARTESIANPOINT({});#11=IFCCARTESIANPOINT({});#12=IFCPOLYLINE((#10,#11));
#13=IFCCARTESIANPOINT({});#14=IFCDIRECTION((-0.9583864791051044,0.2854739159161845));
#15=IFCAXIS2PLACEMENT2D(#13,#14);#16=IFCCIRCLE(#15,{:?});
#17=IFCTRIMMEDCURVE(#16,(IFCPARAMETERVALUE(0.4004577362866802)),(IFCPARAMETERVALUE(16.58717889379865)),.T.,.PARAMETER.);
#18=IFCCARTESIANPOINT({});#19=IFCCARTESIANPOINT({});#20=IFCPOLYLINE((#18,#19));
#21=IFCCIRCLE(#15,{:?});
#22=IFCTRIMMEDCURVE(#21,(IFCPARAMETERVALUE(3.562221243239142E-013)),(IFCPARAMETERVALUE(16.58717889379865)),.T.,.PARAMETER.);
#23=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#12);#24=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.F.,#17);
#25=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#20);#26=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#22);
#27=IFCCOMPOSITECURVE((#23,#24,#25,#26),.F.);#28=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#27);
#29=IFCCARTESIANPOINT((0.,0.,0.));#30=IFCAXIS2PLACEMENT3D(#29,$,$);#31=IFCDIRECTION((0.,0.,1.));
#32=IFCEXTRUDEDAREASOLID(#28,#30,#31,{DEPTH:?});
#33=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#32));#34=IFCPRODUCTDEFINITIONSHAPE($,$,(#33));
#35=IFCLOCALPLACEMENT($,#30);
#36=IFCMEMBER('0000000000000000000001',$,'SYNTHETIC mullion',$,$,#35,#34,$,$);
ENDSEC;END-ISO-10303-21;",
        p(-0.1191200550864879, -0.6535333285020208), p(-0.06912005508648793, -0.6535333285020206),
        p(4.53857932089166, -0.6535333285020071), 4.607699375978148 * k,
        p(0.1135368949550646, 0.6309483054852538), p(0.07470321521791104, 0.6761183515188154),
        4.657699375978148 * k)
}
fn run(text: &str, worker: &std::ffi::OsStr) -> ProductOutcome {
    let mut outcomes = Vec::new();
    ifc_lite_retained_native::run_model_native(SourceBundle::new(text.as_bytes().to_vec()), worker,
        &ModelOptions { ids: Some([36].into_iter().collect()), ..Default::default() }, |o| outcomes.push(o)).unwrap();
    assert_eq!(outcomes.len(), 1, "one atomic publication/refusal");
    outcomes.pop().unwrap()
}

#[test]
fn issue_7955_mismatched_arc_tessellation_refuses_real_sdk() {
    let Some(worker) = worker() else { return };
    let outcome = run(&mullion(1.), &worker);
    let ProductOutcome::Refused { refusal, origin, .. } = &outcome else {
        panic!("a +0.68% curved mullion must not publish: {outcome:?}")
    };
    assert_eq!(refusal.code(), "incomplete");
    let origin = origin.expect("typed origin");
    assert_eq!((origin.site, origin.entity, origin.cause), ("chordal_volume", Some(32), "curved_volume_tolerance"));

    // The same profile at 0.9 scale: both arcs get 8 segments, -0.094%.
    let outcome = run(&mullion(0.9), &worker);
    let ProductOutcome::Published(shape) = &outcome else { panic!("expected publication: {outcome:?}") };
    let mut actual = metrics::Metrics::default();
    for part in &shape.parts {
        let points: Vec<_> = part.positions.chunks_exact(3)
            .map(|p| metrics::transform(&part.world_from_object, [p[0], p[1], p[2]])).collect();
        actual.add_mesh(&points, &part.indices).unwrap();
    }
    let expected = AREA * 0.81 * DEPTH;
    assert_eq!(actual.defects, 0, "closed output");
    assert!(metrics::relative(actual.volume, expected) <= 2e-3, "{} vs {expected}", actual.volume);
    println!("chordal mullion refused {origin:?}; 0.9 scale published {} vs {expected}", actual.volume);
    println!("sdk witness executed: chordal_mullion_refusal");
}
