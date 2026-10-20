// SPDX-License-Identifier: MPL-2.0
//! Decoder-free open-strip construction and ordered admission invariants.
use super::LinearExtrusionSurfacePlan;
use crate::processors::SurfaceOfLinearExtrusionProcessor;
use ifc_lite_core::EntityDecoder;

const CURVE: &str = "#10=IFCCARTESIANPOINT((0.4,0.3));
#11=IFCCARTESIANPOINT((0.412,0.3));
#12=IFCPOLYLINE((#10,#11));
#13=IFCARBITRARYOPENPROFILEDEF(.CURVE.,$,#12);
#14=IFCCARTESIANPOINT((2600000.,1200000.,0.));
#15=IFCAXIS2PLACEMENT3D(#14,$,$);
#16=IFCDIRECTION((0.,0.,1.));";

fn lower(source: &str, rtc: Option<(f64, f64, f64)>) -> crate::Result<LinearExtrusionSurfacePlan> {
    let mut decoder = EntityDecoder::new(source);
    let entity = decoder.decode_by_id(900)?;
    SurfaceOfLinearExtrusionProcessor::new().lower(&entity, &mut decoder, rtc)
}

#[test]
fn surface_plan_replays_survey_coordinates_with_f64_rtc_before_narrowing() {
    let plan = {
        let source = format!("{CURVE}\n#900=IFCSURFACEOFLINEAREXTRUSION(#13,#15,#16,0.005);");
        lower(&source, Some((2600000., 1200000., 0.))).unwrap()
    };
    let mesh = plan.evaluate();
    assert!(mesh.rtc_applied);
    assert_eq!(mesh.positions.len(), 12);
    assert_eq!(mesh.indices.len(), 6);
    let width = mesh.positions[3] - mesh.positions[0];
    let depth = mesh.positions[8] - mesh.positions[2];
    assert!((width as f64 - 0.012).abs() < 2e-8);
    assert!((depth as f64 - 0.005).abs() < 1e-9);
    assert!((width as f64 * depth as f64 - 0.00006).abs() < 2e-10);
    assert_eq!(mesh.positions, plan.clone().evaluate().positions);
}

#[test]
fn surface_depth_and_curve_admission_precede_zero_direction_refusal() {
    let base = format!("{CURVE}\n#17=IFCDIRECTION((0.,0.,0.));");
    let depth_error = lower(
        &format!("{base}\n#900=IFCSURFACEOFLINEAREXTRUSION(#13,#15,#17,0.);"),
        None,
    )
    .unwrap_err()
    .to_string();
    assert!(
        depth_error.contains("not a positive length"),
        "{depth_error}"
    );
    let direction_error = lower(
        &format!("{base}\n#900=IFCSURFACEOFLINEAREXTRUSION(#13,#15,#17,1.);"),
        None,
    )
    .unwrap_err()
    .to_string();
    assert!(direction_error.contains("zero length"), "{direction_error}");
    let curve_error = lower(&format!("{base}\n#18=IFCPOLYLINE((#10));\n#19=IFCARBITRARYOPENPROFILEDEF(.CURVE.,$,#18);\n#900=IFCSURFACEOFLINEAREXTRUSION(#19,#15,#17,1.);"), None)
        .unwrap_err().to_string();
    assert!(curve_error.contains("has 1 point(s)"), "{curve_error}");
}
