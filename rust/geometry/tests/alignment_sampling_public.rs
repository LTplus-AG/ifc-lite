// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use ifc_lite_core::{build_entity_index, EntityDecoder};
use ifc_lite_geometry::{sample_alignment_axes, AlignmentCurve, AlignmentSamplingDiagnostic,
    AlignmentSamplingDiagnosticCode, SampledAlignmentAxis};

fn model(extra: &str) -> String {
    format!("ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4X1'));ENDSEC;DATA;
#1=IFCPROJECT('p',$,$,$,$,$,$,$,#2);
#2=IFCUNITASSIGNMENT((#3));#3=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#20=IFCALIGNMENT('a',$,'Road',$,$,$,$,#12);
{extra} ENDSEC;END-ISO-10303-21;")
}

#[test]
fn issue_6600_positive_vertical_measures_are_strict_without_changing_renderer_policy() {
    for subtype in ["PARABOLICARC", "CIRCULARARC"] {
        for measure in ["0.", "-100.", "1.E999", "100."] {
            let content = model(&format!("#36=IFCCARTESIANPOINT((0.,0.));#30=IFCLINESEGMENT2D(#36,0.,100.);#31=IFCALIGNMENT2DHORIZONTALSEGMENT($,$,$,#30);#32=IFCALIGNMENT2DHORIZONTAL(0.,(#31));#33=IFCALIGNMENT2DVERSEG{subtype}($,$,$,0.,100.,50.,0.1,{measure},.T.);#34=IFCALIGNMENT2DVERTICAL((#33));#35=IFCALIGNMENTCURVE(#32,#34,$);"))
                .replace("'Road',$,$,$,$,#12", "'Road',$,$,$,$,#35");
            let report = sample_alignment_axes(&content, Default::default()).unwrap();
            if measure == "100." {
                let axis: &SampledAlignmentAxis = &report.axes[0];
                assert_eq!(axis.geometric_horizontal_length_m, 100.);
                assert!(axis.samples.iter().all(|sample| sample.point.iter().all(|v| v.is_finite())));
                assert!(report.diagnostics.is_empty());
                continue;
            }
            assert!(report.axes.is_empty(), "{subtype}: {measure}");
            let diagnostics: &[AlignmentSamplingDiagnostic] = &report.diagnostics;
            assert!(diagnostics.iter().any(|d| d.express_id == Some(20)
                && matches!(d.code, AlignmentSamplingDiagnosticCode::InvalidAxis)));
            let mut decoder = EntityDecoder::with_index(&content, build_entity_index(&content));
            let directrix = decoder.decode_by_id(35).unwrap();
            // The existing renderer explicitly retains its permissive policy.
            assert!(AlignmentCurve::parse(&directrix, &mut decoder).unwrap().is_some());
        }
    }
}

/// #7678 (PROC-AL-16): an `IfcCircularArcSegment2D` radius the double range
/// cannot hold (`1.E400`) passed the `radius < 1e-12` check as infinity, and
/// the renderer's permissive parse then evaluated `sx + inf * 0` into NaN
/// vertices. The decode boundary now refuses the segment record, so the
/// renderer's parse fails closed instead; a finite radius, and a `-0.`
/// start coordinate, still evaluate finitely.
#[test]
fn issue_7678_an_overflowing_arc_radius_never_evaluates_to_nan() {
    let curve = |radius: &str| {
        model(&format!("#36=IFCCARTESIANPOINT((-0.,0.));#30=IFCCIRCULARARCSEGMENT2D(#36,0.,50.,{radius},.T.);#31=IFCALIGNMENT2DHORIZONTALSEGMENT($,$,$,#30);#32=IFCALIGNMENT2DHORIZONTAL(0.,(#31));#35=IFCALIGNMENTCURVE(#32,$,$);"))
            .replace("'Road',$,$,$,$,#12", "'Road',$,$,$,$,#35")
    };
    for radius in ["1.E400", "-1.E400"] {
        let content = curve(radius);
        let mut decoder = EntityDecoder::with_index(&content, build_entity_index(&content));
        let directrix = decoder.decode_by_id(35).unwrap();
        match AlignmentCurve::parse(&directrix, &mut decoder) {
            Ok(Some(parsed)) => {
                let frame = parsed.evaluate(25.0);
                panic!("{radius}: admitted, evaluates to {:?}", frame.origin);
            }
            Ok(None) | Err(_) => {}
        }
        let report = sample_alignment_axes(&content, Default::default()).unwrap();
        assert!(report.axes.is_empty(), "{radius}");
    }
    let content = curve("100.");
    let mut decoder = EntityDecoder::with_index(&content, build_entity_index(&content));
    let directrix = decoder.decode_by_id(35).unwrap();
    let parsed = AlignmentCurve::parse(&directrix, &mut decoder).unwrap().expect("finite arc");
    for station in [0.0, 25.0, 50.0] {
        let origin = parsed.evaluate(station).origin;
        assert!(origin.iter().all(|v| v.is_finite()), "{station}: {origin:?}");
    }
}
