// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use ifc_lite_landxml::{
    alignment::{
        parse_landxml_alignments_with_cancel, LandXmlAlignmentLimits, LandXmlPointLocation,
        LandXmlSuperelevationEventKind,
    },
    LandXmlCancellationFlag, LandXmlDiagnosticCode,
};

const XML: &str = r#"<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2">
<Units><Metric linearUnit="meter" elevationUnit="meter"/></Units>
<Alignments><Alignment name="Main Road" length="140" staStart="100">
<Start>1000 2000 5</Start><CoordGeom>
<Line length="10"><Start>1000 2000</Start><End>1010 2000</End></Line>
<Curve rot="ccw" radius="10" length="15.707963267948966"><Start>1010 2000</Start><Center>1000 2000</Center><End>1000 2010</End><PI>1010 2010</PI></Curve>
<Spiral spiType="clothoid" radiusStart="INF" radiusEnd="200" rot="ccw" length="100"><Start>1000 2010</Start><PI>1050 2020</PI><End>1095 2030</End></Spiral>
<IrregularLine length="20"><Start>1095 2030</Start><End>1105 2040</End><PntList2D>1095 2030 1095 2040 1105 2040</PntList2D></IrregularLine>
<Spiral spiType="bloss" radiusStart="INF" radiusEnd="50" rot="ccw" length="5"><Start>1105 2040</Start><PI>1107 2040</PI><End>1110 2040</End></Spiral>
</CoordGeom>
<StaEquation staInternal="150" staBack="150" staAhead="200" staIncrement="increasing"/>
<Cant name="Rail" gauge="1.435" rotationPoint="center"><CantStation station="110" appliedCant="20" equilibriumCant="22" curvature="ccw"/><CantStation station="120" appliedCant="30" curvature="ccw"/></Cant>
<Superelevation staStart="110" staEnd="130"><BeginRunoutSta>110</BeginRunoutSta><FullSuperelev>0.06</FullSuperelev><AdverseSE>non-adverse</AdverseSE></Superelevation>
</Alignment></Alignments></LandXML>"#;

#[test]
fn issue_5044_parses_exact_alignment_semantics_without_rendering_identity() {
    let document = parse_landxml_alignments_with_cancel(
        XML.as_bytes(),
        &LandXmlAlignmentLimits::default(),
        None,
    )
    .expect("parse alignment source");
    assert_eq!(document.units.expect("units").linear_unit, "meter");
    let alignment = &document.alignments[0];
    assert_eq!(alignment.source_id.0, "landxml:alignment:1:Main Road");
    assert_eq!(
        alignment.segments.len(),
        4,
        "Line, Curve, clothoid Spiral, IrregularLine"
    );
    assert_eq!(
        alignment.segments[1].source_id.0,
        "landxml:alignment:1:Main Road:segment:2"
    );
    assert_eq!(alignment.unsupported_transitions.len(), 1);
    assert_eq!(alignment.unsupported_transitions[0].spi_type, "bloss");
    assert_eq!(alignment.station_equations[0].sta_ahead, 200.0);
    let cant = alignment.cant.as_ref().expect("cant");
    assert_eq!(cant.stations[1].applied_cant, 30.0);
    let superelevation = &alignment.superelevations[0];
    assert_eq!(
        superelevation.events[1].kind,
        LandXmlSuperelevationEventKind::FullSuperelev
    );
    assert_eq!(superelevation.events[1].value, "0.06");
    match alignment.start.as_ref().expect("alignment start") {
        LandXmlPointLocation::Coordinates { point } => assert_eq!(
            (point.northing, point.easting, point.elevation),
            (1000.0, 2000.0, Some(5.0))
        ),
        LandXmlPointLocation::PointReference { .. } => panic!("expected coordinates"),
    }
}

#[test]
fn issue_5044_preserves_pnt_ref_instead_of_inventing_a_coordinate() {
    let xml = XML.replace(
        "<Start>1000 2000</Start><End>1010 2000</End>",
        "<Start pntRef=\"CG-1\"/><End>1010 2000</End>",
    );
    let document = parse_landxml_alignments_with_cancel(
        xml.as_bytes(),
        &LandXmlAlignmentLimits::default(),
        None,
    )
    .expect("parse point reference");
    match &document.alignments[0].segments[0].primitive {
        ifc_lite_landxml::alignment::LandXmlAlignmentPrimitive::Line(line) => assert_eq!(
            line.start,
            LandXmlPointLocation::PointReference {
                pnt_ref: "CG-1".to_owned()
            }
        ),
        _ => panic!("expected line"),
    }
}

#[test]
fn issue_5044_refuses_over_limit_and_honors_cancellation() {
    let limits = LandXmlAlignmentLimits {
        max_alignment_segments: 1,
        ..LandXmlAlignmentLimits::default()
    };
    let error = parse_landxml_alignments_with_cancel(XML.as_bytes(), &limits, None)
        .expect_err("segment limit");
    assert_eq!(error.code, LandXmlDiagnosticCode::LimitExceeded);
    let limits = LandXmlAlignmentLimits {
        max_alignment_points: 1,
        ..LandXmlAlignmentLimits::default()
    };
    let error = parse_landxml_alignments_with_cancel(XML.as_bytes(), &limits, None)
        .expect_err("point limit");
    assert_eq!(error.code, LandXmlDiagnosticCode::LimitExceeded);
    let cancelled = LandXmlCancellationFlag::new();
    cancelled.cancel();
    let error = parse_landxml_alignments_with_cancel(
        XML.as_bytes(),
        &LandXmlAlignmentLimits::default(),
        Some(&cancelled),
    )
    .expect_err("cancelled");
    assert_eq!(error.code, LandXmlDiagnosticCode::Cancelled);
}

#[test]
fn issue_5044_refuses_unknown_transition_without_rewriting_its_type() {
    let document = parse_landxml_alignments_with_cancel(
        XML.as_bytes(),
        &LandXmlAlignmentLimits::default(),
        None,
    )
    .expect("parse");
    let transition = &document.alignments[0].unsupported_transitions[0];
    assert_eq!(
        transition.source_id.0,
        "landxml:alignment:1:Main Road:segment:5"
    );
    assert!(transition.reason.contains("clothoid"));
}
