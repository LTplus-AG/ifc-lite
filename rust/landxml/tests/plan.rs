/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use ifc_lite_landxml::{
    parse_landxml_plan_with_cancel, LandXmlCancellationFlag, LandXmlDiagnosticCode,
    LandXmlParcelState, LandXmlPlanLimits, LANDXML_12_NAMESPACE,
};

fn parse(xml: &str) -> ifc_lite_landxml::LandXmlPlanDocument {
    parse_landxml_plan_with_cancel(xml.as_bytes(), &LandXmlPlanLimits::default(), None)
        .expect("valid plan fixture")
}

fn document(body: &str) -> String {
    format!(
        r#"<LandXML xmlns="{LANDXML_12_NAMESPACE}" version="1.2"><Units><Imperial linearUnit="foot" areaUnit="squareFoot"/></Units>{body}</LandXML>"#
    )
}

#[test]
fn issue_5046_retains_cogo_monuments_and_analytic_plan_features() {
    let parsed = parse(&document(
        r#"
        <CgPoints><CgPoint name="CP-1" code="control" desc="north">10 20 5</CgPoint></CgPoints>
        <Monuments><Monument name="M-1" pntRef="CP-1" type="pin"/></Monuments>
        <PlanFeatures><PlanFeature name="edge" code="ROW" desc="right-of-way"><CoordGeom>
          <Line length="10"><Start pntRef="CP-1"/><End>20 20 5</End></Line>
          <Curve rot="ccw" radius="5"><Start>20 20</Start><Center>20 25</Center><End>25 25</End><PI>24 24</PI></Curve>
        </CoordGeom></PlanFeature></PlanFeatures>
    "#,
    ));
    assert_eq!(parsed.units.as_ref().expect("units").linear_unit, "foot");
    assert_eq!(parsed.cogo_points[0].source_id.0, "landxml:CgPoint:1:CP-1");
    assert_eq!(parsed.cogo_points[0].code.as_deref(), Some("control"));
    assert_eq!(parsed.monuments[0].pnt_ref.as_deref(), Some("CP-1"));
    assert_eq!(
        parsed
            .resolve_monument_point(&parsed.monuments[0])
            .expect("monument point")
            .elevation,
        Some(5.0)
    );
    let feature = &parsed.plan_features[0];
    assert_eq!(feature.geometry.len(), 2);
    assert_eq!(feature.geometry[0].declared_length, Some(10.0));
    assert_eq!(feature.geometry[1].radius, Some(5.0));
    assert_eq!(feature.geometry[1].pi.as_ref().map(|_| "PI"), Some("PI"));
}

#[test]
fn issue_5046_prefers_direct_monument_coordinates_over_pntref() {
    let parsed = parse(&document(
        r#"<CgPoints><CgPoint name="control">1 2</CgPoint></CgPoints><Monuments><Monument pntRef="control">8 9 10</Monument></Monuments>"#,
    ));
    let point = parsed
        .resolve_monument_point(&parsed.monuments[0])
        .expect("direct monument coordinate");
    assert_eq!(
        (point.northing, point.easting, point.elevation),
        (8.0, 9.0, Some(10.0))
    );
}

#[test]
fn issue_5046_resolves_repeated_cogo_names_by_document_scope() {
    let parsed = parse(&document(
        r#"
        <CgPoints><CgPoint name="shared">1 1</CgPoint></CgPoints>
        <PlanFeatures><PlanFeature name="first"><CoordGeom><Line><Start pntRef="shared"/><End>1 2</End></Line></CoordGeom></PlanFeature></PlanFeatures>
        <CgPoints><CgPoint name="shared">9 9</CgPoint></CgPoints>
        <PlanFeatures><PlanFeature name="second"><CoordGeom><Line><Start pntRef="shared"/><End>9 10</End></Line></CoordGeom></PlanFeature></PlanFeatures>
    "#,
    ));
    let first = &parsed.plan_features[0].geometry[0];
    let second = &parsed.plan_features[1].geometry[0];
    assert_eq!(
        parsed
            .resolve_point(first.point_scope_id.as_ref(), &first.start)
            .expect("first ref")
            .northing,
        1.0
    );
    assert_eq!(
        parsed
            .resolve_point(second.point_scope_id.as_ref(), &second.start)
            .expect("second ref")
            .northing,
        9.0
    );
    assert_ne!(first.point_scope_id, second.point_scope_id);
}

#[test]
fn issue_5046_probes_closed_line_and_curve_parcels_in_declared_units() {
    let parsed = parse(&document(
        r#"
      <Parcels><Parcel name="half-disk" area="1.5707963267948966" perimeter="5.141592653589793"><CoordGeom>
        <Curve rot="ccw" radius="1"><Start>1 0</Start><Center>0 0</Center><End>-1 0</End></Curve>
        <Line><Start>-1 0</Start><End>1 0</End></Line>
      </CoordGeom></Parcel></Parcels>
    "#,
    ));
    let parcel = &parsed.parcels[0];
    let probe = parsed.probe_parcel(parcel);
    assert_eq!(probe.state, LandXmlParcelState::Analytic);
    assert!(
        (probe.perimeter_in_declared_linear_units.expect("perimeter")
            - (std::f64::consts::PI + 2.0))
            .abs()
            < 1e-12
    );
    assert!(
        (probe.area_in_declared_square_units.expect("area") - std::f64::consts::PI / 2.0).abs()
            < 1e-12
    );
    assert_eq!(probe.declared_area, Some(std::f64::consts::PI / 2.0));
    assert!(
        (probe.area_in_square_meters.expect("area conversion")
            - std::f64::consts::PI / 2.0 * 0.092_903_04)
            .abs()
            < 1e-12
    );
}

#[test]
fn issue_5046_uses_northing_easting_arc_orientation_and_declared_major_arcs() {
    let parsed = parse(&document(
        r#"<Parcels>
          <Parcel name="ccw-major"><CoordGeom>
            <Curve rot="ccw" radius="1"><Start>1 0</Start><Center>0 0</Center><End>0 1</End></Curve>
            <Line><Start>0 1</Start><End>1 0</End></Line>
          </CoordGeom></Parcel>
          <Parcel name="cw-minor"><CoordGeom>
            <Curve rot="cw" radius="1"><Start>1 0</Start><Center>0 0</Center><End>0 1</End></Curve>
            <Line><Start>0 1</Start><End>1 0</End></Line>
          </CoordGeom></Parcel>
          <Parcel name="cw-declared-major"><CoordGeom>
            <Curve rot="cw" radius="1" length="4.71238898038469"><Start>1 0</Start><Center>0 0</Center><End>0 -1</End></Curve>
            <Line><Start>0 -1</Start><End>1 0</End></Line>
          </CoordGeom></Parcel>
        </Parcels>"#,
    ));
    let areas: Vec<f64> = parsed
        .parcels
        .iter()
        .map(|parcel| {
            parsed
                .probe_parcel(parcel)
                .area_in_declared_square_units
                .expect("analytic arc boundary")
        })
        .collect();
    let major = 3.0 * std::f64::consts::PI / 4.0 + 0.5;
    let minor = std::f64::consts::PI / 4.0 - 0.5;
    assert!((areas[0] - major).abs() < 1e-12);
    assert!((areas[1] - minor).abs() < 1e-12);
    assert!((areas[2] - major).abs() < 1e-12);
}

#[test]
fn issue_5046_preserves_open_and_self_intersecting_parcels_without_fills() {
    for boundary in [
        r#"<Line><Start>0 0</Start><End>2 0</End></Line><Line><Start>2 0</Start><End>2 2</End></Line>"#,
        r#"<Line><Start>0 0</Start><End>2 2</End></Line><Line><Start>2 2</Start><End>0 2</End></Line><Line><Start>0 2</Start><End>2 0</End></Line><Line><Start>2 0</Start><End>0 0</End></Line>"#,
    ] {
        let parsed = parse(&document(&format!(
            "<Parcels><Parcel name=\"bad\"><CoordGeom>{boundary}</CoordGeom></Parcel></Parcels>"
        )));
        let probe = parsed.probe_parcel(&parsed.parcels[0]);
        assert!(matches!(
            probe.state,
            LandXmlParcelState::PreservedOnly { .. }
        ));
        assert_eq!(probe.area_in_declared_square_units, None);
    }
}

#[test]
fn issue_5046_accepts_simple_square_and_uses_linear_units_for_geometric_area() {
    let square = parse(&document(
        r#"<Parcels><Parcel name="square"><CoordGeom>
        <Line><Start>0 0</Start><End>10 0</End></Line>
        <Line><Start>10 0</Start><End>10 10</End></Line>
        <Line><Start>10 10</Start><End>0 10</End></Line>
        <Line><Start>0 10</Start><End>0 0</End></Line>
        </CoordGeom></Parcel></Parcels>"#,
    ));
    assert_eq!(
        square.probe_parcel(&square.parcels[0]).state,
        LandXmlParcelState::Analytic
    );

    let metric = parse(&format!(
        r#"<LandXML xmlns="{LANDXML_12_NAMESPACE}" version="1.2"><Units><Metric linearUnit="meter" areaUnit="hectare"/></Units><Parcels><Parcel><CoordGeom><Curve rot="ccw" radius="1"><Start>1 0</Start><Center>0 0</Center><End>-1 0</End></Curve><Line><Start>-1 0</Start><End>1 0</End></Line></CoordGeom></Parcel></Parcels></LandXML>"#,
    ));
    let area = metric
        .probe_parcel(&metric.parcels[0])
        .area_in_square_meters
        .expect("area");
    assert!((area - std::f64::consts::PI / 2.0).abs() < 1e-12);
}

#[test]
fn issue_5046_charges_pntref_against_the_shared_reference_limit() {
    let source = document(
        r#"<CgPoints><CgPoint name="one">0 0</CgPoint></CgPoints><PlanFeatures><PlanFeature><CoordGeom><Line><Start pntRef="one"/><End>1 1</End></Line></CoordGeom></PlanFeature></PlanFeatures>"#,
    );
    let mut limits = LandXmlPlanLimits::default();
    limits.xml.max_references = 0;
    assert_eq!(
        parse_landxml_plan_with_cancel(source.as_bytes(), &limits, None)
            .unwrap_err()
            .code,
        LandXmlDiagnosticCode::LimitExceeded
    );
}

#[test]
fn issue_5046_refuses_record_growth_and_honors_cancellation() {
    let source = document("<CgPoints><CgPoint name=\"one\">0 0</CgPoint><CgPoint name=\"two\">1 1</CgPoint></CgPoints>");
    let limits = LandXmlPlanLimits {
        max_cogo_points: 1,
        ..LandXmlPlanLimits::default()
    };
    assert_eq!(
        parse_landxml_plan_with_cancel(source.as_bytes(), &limits, None)
            .unwrap_err()
            .code,
        LandXmlDiagnosticCode::LimitExceeded
    );
    let cancelled = LandXmlCancellationFlag::new();
    cancelled.cancel();
    assert_eq!(
        parse_landxml_plan_with_cancel(
            source.as_bytes(),
            &LandXmlPlanLimits::default(),
            Some(&cancelled)
        )
        .unwrap_err()
        .code,
        LandXmlDiagnosticCode::Cancelled
    );

    assert_eq!(
        parse_landxml_plan_with_cancel(
            source
                .replace(LANDXML_12_NAMESPACE, "urn:vendor")
                .as_bytes(),
            &LandXmlPlanLimits::default(),
            None
        )
        .unwrap_err()
        .code,
        LandXmlDiagnosticCode::UnsupportedNamespace
    );
}

#[test]
fn issue_5046_keeps_schema_valid_title_property_location_and_cogo_aliases() {
    let parsed = parse(&document(
        r#"<Survey><CgPoints><CgPoint name="origin">1 2 3</CgPoint><CgPoint name="alias" pntRef="origin"/></CgPoints></Survey>
        <PlanFeatures><PlanFeature name="road"><Property label="phase" value="design"/><Feature><Location pntRef="alias">99 100</Location></Feature><CoordGeom><IrregularLine><Start pntRef="alias"/><PntList2D>2 2 3 2</PntList2D><End>4 2</End></IrregularLine></CoordGeom></PlanFeature></PlanFeatures>
        <Parcels><Parcel name="lot"><Title name="DEED-123" titleType="freehold"/></Parcel></Parcels>"#,
    ));
    let feature = &parsed.plan_features[0];
    assert_eq!(parsed.parcels[0].title.as_deref(), Some("DEED-123"));
    assert_eq!(
        feature.properties.get("phase").map(String::as_str),
        Some("design")
    );
    assert_eq!(feature.geometry[0].intermediate_points.len(), 2);
    assert_eq!(
        parsed
            .resolve_point(
                None,
                &ifc_lite_landxml::LandXmlPlanPointLocation::PointReference {
                    pnt_ref: "alias".to_owned()
                }
            )
            .expect("alias")
            .elevation,
        Some(3.0)
    );
    assert_eq!(
        parsed
            .resolve_point(None, &feature.locations[0])
            .expect("coordinate priority")
            .northing,
        99.0
    );
    assert_eq!(parsed.source_batches(1).len(), 5);
}

#[test]
fn issue_5046_preserves_nested_parcels_and_malformed_primitives() {
    let parsed = parse(&document(
        r#"<Parcels><Parcel name="outer"><CoordGeom><Line><Start>0 0</Start><End>1 0</End></Line></CoordGeom><Parcels><Parcel name="inner"><CoordGeom><Line><Start>0 0</Start></Line></CoordGeom></Parcel></Parcels></Parcel></Parcels>"#,
    ));
    assert_eq!(parsed.parcels.len(), 2);
    let malformed = parsed
        .parcels
        .iter()
        .find(|parcel| parcel.name.as_deref() == Some("inner"))
        .expect("inner");
    assert!(matches!(
        parsed.probe_parcel(malformed).state,
        LandXmlParcelState::PreservedOnly { .. }
    ));
    let outer = parsed
        .parcels
        .iter()
        .find(|parcel| parcel.name.as_deref() == Some("outer"))
        .expect("outer");
    assert!(outer.loops[0][0].source_id.0.contains(":loop:1:"));
}

#[test]
fn issue_5046_refuses_multiple_roots_and_mixed_units() {
    let root = document("<CgPoints><CgPoint name=\"a\">0 0</CgPoint></CgPoints>");
    assert_eq!(
        parse_landxml_plan_with_cancel(b"", &LandXmlPlanLimits::default(), None)
            .unwrap_err()
            .code,
        LandXmlDiagnosticCode::InvalidXml
    );
    assert_eq!(
        parse_landxml_plan_with_cancel(
            format!("{root}{root}").as_bytes(),
            &LandXmlPlanLimits::default(),
            None
        )
        .unwrap_err()
        .code,
        LandXmlDiagnosticCode::InvalidXml
    );
    let mixed = root.replace("</Units>", "<Metric linearUnit=\"meter\"/></Units>");
    assert_eq!(
        parse_landxml_plan_with_cancel(mixed.as_bytes(), &LandXmlPlanLimits::default(), None)
            .unwrap_err()
            .code,
        LandXmlDiagnosticCode::InvalidSemantic
    );
}

#[test]
fn issue_5046_bounds_and_cancels_pairwise_parcel_topology() {
    let parsed = parse(&document(
        r#"<Parcels><Parcel name="square"><CoordGeom><Line><Start>0 0</Start><End>1 0</End></Line><Line><Start>1 0</Start><End>1 1</End></Line><Line><Start>1 1</Start><End>0 1</End></Line><Line><Start>0 1</Start><End>0 0</End></Line></CoordGeom></Parcel></Parcels>"#,
    ));
    assert_eq!(
        parsed
            .probe_parcel_with_cancel(&parsed.parcels[0], 1, None)
            .unwrap_err()
            .code,
        LandXmlDiagnosticCode::LimitExceeded
    );
    let cancelled = LandXmlCancellationFlag::new();
    cancelled.cancel();
    assert_eq!(
        parsed
            .probe_parcel_with_cancel(&parsed.parcels[0], 100, Some(&cancelled))
            .unwrap_err()
            .code,
        LandXmlDiagnosticCode::Cancelled
    );
}

#[test]
fn issue_5046_rejects_irregular_crossings_and_indexed_reference_cycles() {
    let crossing = parse(&document(
        r#"<Parcels><Parcel name="cross"><CoordGeom><IrregularLine><Start>0 0</Start><PntList2D>2 2 0 2</PntList2D><End>2 0</End></IrregularLine><Line><Start>2 0</Start><End>0 0</End></Line></CoordGeom></Parcel></Parcels>"#,
    ));
    assert!(matches!(
        crossing.probe_parcel(&crossing.parcels[0]).state,
        LandXmlParcelState::PreservedOnly { .. }
    ));
    let aliases = parse(&document(
        r#"<CgPoints><CgPoint name="base">4 5</CgPoint><CgPoint name="indexed" pntRef="1"/><CgPoint name="a" pntRef="b"/><CgPoint name="b" pntRef="a"/></CgPoints>"#,
    ));
    let reference = |name: &str| ifc_lite_landxml::LandXmlPlanPointLocation::PointReference {
        pnt_ref: name.to_owned(),
    };
    assert_eq!(
        aliases
            .resolve_point(None, &reference("indexed"))
            .expect("indexed ref")
            .northing,
        4.0
    );
    assert_eq!(aliases.resolve_point(None, &reference("a")), None);
}
