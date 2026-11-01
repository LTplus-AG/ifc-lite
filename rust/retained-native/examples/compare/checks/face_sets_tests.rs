// SPDX-License-Identifier: MPL-2.0
//! #7955 F3: only a face set its source authors open skips the closed-solid checks;
//! its rows and corners still gate. Real SDK shapes, so the oracle sees production keys.
use crate::checks::face_sets::{check, AUTHORED_OPEN};
use ifc_lite_core::SourceBundle;
use ifc_lite_retained_native::{run_model_native, ModelOptions, ProductOutcome, ShapeOnlyProduct};

const SHELL: &str = "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4X1'));ENDSEC;DATA;
#1=IFCPROJECT('p',$,$,$,$,$,$,(#2),#3);
#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#5,$);
#3=IFCUNITASSIGNMENT((#6));#4=IFCCARTESIANPOINT((0.,0.,0.));
#5=IFCAXIS2PLACEMENT3D(#4,$,$);#6=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#9=IFCLOCALPLACEMENT($,#5);
#20=IFCBUILDINGELEMENTPROXY('s',$,'Set',$,$,#9,#21,$,.NOTDEFINED.);
#21=IFCPRODUCTDEFINITIONSHAPE($,$,(#22));#22=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#33));
#30=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(1000.,0.,0.),(0.,1000.,0.),(0.,0.,1000.)));
#33=IFCTRIANGULATEDFACESET(#30,$,CLOSED,((1,3,2),(1,2,4),(2,3,4)),$);
ENDSEC;END-ISO-10303-21;";

fn shell(closed: &str) -> String { SHELL.replace("CLOSED", closed) }

fn publish(text: &str) -> Option<ShapeOnlyProduct> {
    let Some(worker) = std::env::var_os("IFCLITE_SMLIB_WORKER") else {
        assert!(std::env::var_os("IFCLITE_REQUIRE_SMLIB").is_none(), "real SDK required");
        eprintln!("SKIP #7955 F3 face-set witness: SDK absent");
        return None;
    };
    let mut products = Vec::new();
    run_model_native(SourceBundle::new(text.as_bytes().to_vec()), &worker,
        &ModelOptions { ids: Some([20].into_iter().collect()), ..Default::default() }, |o| products.push(o)).unwrap();
    match products.pop().unwrap() {
        ProductOutcome::Published(p) => Some(p),
        o => panic!("expected the authored shell to publish: {o:?}"),
    }
}

/// The whole comparison row for one product: `Report::published` with the product's own metrics.
fn report(text: &str, shape: &ShapeOnlyProduct) -> crate::report::Report {
    let mut actual = crate::metrics::Metrics::default();
    for part in &shape.parts {
        let points = part.positions.chunks_exact(3).map(|p| crate::metrics::transform(&part.world_from_object, [p[0], p[1], p[2]])).collect::<Vec<_>>();
        actual.add_mesh(&points, &part.indices).unwrap();
    }
    assert!(actual.defects > 0, "three faces of a tetrahedron are an open mesh");
    // An exact mesh with no volume, as with AB22 #1217's open shells: the deviation is infinite.
    let mut exact = actual.clone();
    exact.volume = 0.;
    let sources = ifc_lite_processing::extract_analytic_quantity_sources(text.as_bytes(), None);
    let bundle = SourceBundle::new(text.as_bytes().to_vec());
    let clips = ifc_lite_retained_native::oracle::clips::ClipOracle::new(&bundle, &sources);
    let context = crate::checks::SourceContext { product_id: 20, analytic: &sources, clips: &clips, hand_volume: None };
    let mut report = crate::report::Report::default();
    report.published("shell", shape, &actual, Some(&actual), Some(&exact), None, &crate::tolerances::registered().unwrap(), 0.,
        None, &context, false, None, text.as_bytes());
    report
}

#[test]
fn issue_7955_authored_open_shell_is_reported_not_failed_for_closure_and_volume() {
    let text = shell(".F.");
    let Some(shape) = publish(&text) else { return };
    let tolerances = crate::tolerances::registered().unwrap();
    let rows = check(&shape, text.as_bytes(), &tolerances);
    assert!(rows.iter().any(|r| r.family == AUTHORED_OPEN && !r.gated), "{:?}", rows.iter().map(|r| r.family).collect::<Vec<_>>());
    assert!(rows.iter().filter(|r| r.gated).all(|r| r.pass), "faithful rows pass");
    let report = report(&text, &shape);
    assert!(report.violations.is_empty(), "{:?}", report.violations);
    let summary = report.summary();
    let open = &summary["authoredOpenFaceSets"];
    assert_eq!(open["count"], 1);
    assert!(open["products"][0]["closureDefects"].as_u64().unwrap() > 0, "skipped closure is reported: {open}");
    assert_eq!(open["products"][0]["exactVolumeRelative"], "infinite", "skipped volume is reported: {open}");
    println!("sdk witness executed: face_set_authored_open");
}

#[test]
fn issue_7955_a_source_closed_or_unknown_set_with_a_hole_still_fails_closure() {
    for closed in [".T.", "$", ".U."] {
        let text = shell(closed);
        let Some(shape) = publish(&text) else { return };
        let rows = check(&shape, text.as_bytes(), &crate::tolerances::registered().unwrap());
        assert!(!rows.iter().any(|r| r.family == AUTHORED_OPEN), "{closed}");
        let report = report(&text, &shape);
        assert!(report.violations.iter().any(|v| v.contains("closure defects")), "{closed}: {:?}", report.violations);
        assert!(report.violations.iter().any(|v| v.contains("nonfinite exact volume deviation")), "{closed}: {:?}", report.violations);
        assert_eq!(report.summary()["authoredOpenFaceSets"]["count"], 0, "{closed}");
    }
    println!("sdk witness executed: face_set_closed_with_hole");
}

#[test]
fn issue_7955_an_authored_open_set_with_a_wrong_corner_or_row_still_fails() {
    let text = shell(".F.");
    let Some(mut moved) = publish(&text) else { return };
    moved.parts[0].positions[3] += 1e-6;
    let mut swapped = publish(&text).unwrap();
    swapped.parts[0].faces.as_mut().unwrap().triangles.swap(0, 1);
    for (name, shape, family) in [("moved corner", moved, "faceSetCorner"), ("swapped rows", swapped, "faceSetCorner")] {
        let report = report(&text, &shape);
        assert!(report.violations.iter().any(|v| v.contains(&format!("{family} source oracle failed"))), "{name}: {:?}", report.violations);
        assert!(!report.violations.iter().any(|v| v.contains("closure defects")), "{name}: only the row check fails");
    }
    println!("sdk witness executed: face_set_open_wrong_rows");
}

#[test]
fn issue_7955_face_set_rows_beside_an_extrusion_are_not_analytic_face_keys() {
    // rvt01 #24624's shape: one Body with an extrusion and a closed face set. M11-F expects
    // only the extrusion's faces; the set's rows are face_sets' to gate, not extra keys.
    let text = shell(".T.").replace("(#33));", "(#33,#44));").replace("ENDSEC;END", "\
#40=IFCCARTESIANPOINT((5000.,0.));#41=IFCAXIS2PLACEMENT2D(#40,$);#42=IFCDIRECTION((0.,0.,1.));
#43=IFCRECTANGLEPROFILEDEF(.AREA.,$,#41,1000.,1000.);#44=IFCEXTRUDEDAREASOLID(#43,#5,#42,1000.);
ENDSEC;END");
    let Some(shape) = publish(&text) else { return };
    assert_eq!(shape.parts.len(), 2, "one part per item");
    let sources = ifc_lite_processing::extract_analytic_quantity_sources(text.as_bytes(), None);
    let rows = crate::checks::faces::check(&shape, &sources, &crate::tolerances::registered().unwrap());
    let keys = rows.iter().find(|r| r.family == "faceKeys").expect("the extrusion has analytic faces");
    assert!(keys.pass && keys.value == 0., "row keys counted as mismatched: {}", keys.value);
    assert!(check(&shape, text.as_bytes(), &crate::tolerances::registered().unwrap()).iter().filter(|r| r.gated).all(|r| r.pass));
    println!("sdk witness executed: face_set_beside_extrusion");
}

#[test]
fn issue_7955_an_open_set_mapped_twice_with_one_copy_lost_keeps_the_closed_solid_checks() {
    // Both copies key the same set: one published key must not stand for two occurrences.
    let text = shell(".F.").replace("(#33));", "(#51,#52));").replace("ENDSEC;END", "\
#50=IFCREPRESENTATIONMAP(#5,#53);#53=IFCSHAPEREPRESENTATION(#2,'Body','Tessellation',(#33));
#54=IFCCARTESIANPOINT((5000.,0.,0.));#55=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#4,$,$);#56=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#54,$,$);
#51=IFCMAPPEDITEM(#50,#55);#52=IFCMAPPEDITEM(#50,#56);
ENDSEC;END");
    let Some(mut shape) = publish(&text) else { return };
    let tolerances = crate::tolerances::registered().unwrap();
    assert_eq!(shape.parts.len(), 2, "one part per mapped copy");
    assert!(check(&shape, text.as_bytes(), &tolerances).iter().any(|r| r.family == AUTHORED_OPEN), "both copies published");
    shape.parts.pop();
    assert!(!check(&shape, text.as_bytes(), &tolerances).iter().any(|r| r.family == AUTHORED_OPEN), "a lost copy is not waived");
    println!("sdk witness executed: face_set_open_mapped_twice");
}
