/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use ifc_lite_landxml::{
    parse_landxml_document, parse_landxml_plan_with_cancel, LandXmlCancellation,
    LandXmlCancellationFlag, LandXmlDiagnosticCode, LandXmlParcelState, LandXmlPlanLimits,
    LandXmlPlanResolver, LANDXML_12_NAMESPACE,
};
use std::sync::atomic::{AtomicUsize, Ordering};

fn parse(xml: &str) -> ifc_lite_landxml::LandXmlPlanDocument {
    parse_landxml_plan_with_cancel(xml.as_bytes(), &LandXmlPlanLimits::default(), None)
        .expect("valid plan fixture")
}

fn document(body: &str) -> String {
    format!(
        r#"<LandXML xmlns="{LANDXML_12_NAMESPACE}" version="1.2"><Units><Imperial linearUnit="foot" areaUnit="squareFoot"/></Units>{body}</LandXML>"#
    )
}

fn aliased_triangle_parcels(count: usize) -> String {
    let mut aliases = String::from(r#"<CgPoints><CgPoint name="a0">0 0</CgPoint>"#);
    for ordinal in 1..=count {
        aliases.push_str(&format!(
            r#"<CgPoint name="a{ordinal}" pntRef="a{}"/>"#,
            ordinal - 1
        ));
    }
    aliases.push_str("</CgPoints><Parcels>");
    for ordinal in 0..count {
        aliases.push_str(&format!(
            r#"<Parcel name="p{ordinal}"><CoordGeom><Line><Start pntRef="a{count}"/><End>1 0</End></Line><Line><Start>1 0</Start><End>0 1</End></Line><Line><Start>0 1</Start><End pntRef="a{count}"/></Line></CoordGeom></Parcel>"#
        ));
    }
    aliases.push_str("</Parcels>");
    document(&aliases)
}

fn regular_line_parcel(edges: usize, name: &str) -> String {
    let mut lines = String::new();
    for ordinal in 0..edges {
        let angle = std::f64::consts::TAU * ordinal as f64 / edges as f64;
        let next_angle = std::f64::consts::TAU * (ordinal + 1) as f64 / edges as f64;
        lines.push_str(&format!(
            "<Line><Start>{} {}</Start><End>{} {}</End></Line>",
            angle.sin(),
            angle.cos(),
            next_angle.sin(),
            next_angle.cos(),
        ));
    }
    format!("<Parcel name=\"{name}\"><CoordGeom>{lines}</CoordGeom></Parcel>")
}

fn curved_multi_loop_parcel(triangle: &str) -> String {
    format!(
        r#"<Parcel name="curved-multi"><CoordGeom>
          <Curve rot="ccw" radius="1"><Start>0 1</Start><Center>0 0</Center><End>0 -1</End></Curve>
          <Line><Start>0 -1</Start><End>0 1</End></Line>
        </CoordGeom><CoordGeom>{triangle}</CoordGeom></Parcel>"#
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
    assert_eq!(
        parsed.cogo_points()[0].source_id.0,
        "landxml:CgPoint:1:CP-1"
    );
    assert_eq!(parsed.cogo_points()[0].code.as_deref(), Some("control"));
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
fn issue_5046_canonical_document_keeps_terrain_and_plan_from_the_same_bytes() {
    let source = document(
        r#"<CgPoints><CgPoint name="control">1 2</CgPoint></CgPoints><PlanFeatures><PlanFeature name="edge"><CoordGeom><Line><Start pntRef="control"/><End>3 4</End></Line></CoordGeom></PlanFeature></PlanFeatures>"#,
    );
    let document = parse_landxml_document(source.as_bytes()).expect("canonical document");
    assert_eq!(document.terrain.schema, "LandXML-1.2");
    assert_eq!(document.plan.cogo_points().len(), 1);
    assert_eq!(document.plan.plan_features.len(), 1);
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
fn issue_5046_rejects_retraced_and_collinear_zero_area_line_loops() {
    for boundary in [
        r#"<Line><Start>0 0</Start><End>1 0</End></Line><Line><Start>1 0</Start><End>0 0</End></Line>"#,
        r#"<Line><Start>0 0</Start><End>1 0</End></Line><Line><Start>1 0</Start><End>2 0</End></Line><Line><Start>2 0</Start><End>0 0</End></Line>"#,
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
fn issue_5046_preserves_malformed_parcel_coordinates_without_losing_valid_document_records() {
    let parsed = parse(&document(
        r#"<CgPoints><CgPoint name="safe">1 2</CgPoint></CgPoints><Parcels><Parcel name="bad"><CoordGeom><Line><Start>NaN 0</Start><End>1 0</End></Line></CoordGeom></Parcel><Parcel name="good"><CoordGeom><Line><Start>0 0</Start><End>1 0</End></Line><Line><Start>1 0</Start><End>0 1</End></Line><Line><Start>0 1</Start><End>0 0</End></Line></CoordGeom></Parcel></Parcels>"#,
    ));
    assert_eq!(
        parsed.cogo_points().len(),
        1,
        "unrelated source evidence survives"
    );
    assert!(matches!(
        parsed.probe_parcel(&parsed.parcels[0]).state,
        LandXmlParcelState::PreservedOnly { .. }
    ));
    assert_eq!(
        parsed.probe_parcel(&parsed.parcels[1]).state,
        LandXmlParcelState::Analytic
    );
}

#[test]
fn issue_5046_isolates_empty_and_duplicate_parcel_points_without_aborting_document() {
    let parsed = parse(&document(
        r#"<CgPoints><CgPoint name="safe">1 2</CgPoint></CgPoints><Parcels>
          <Parcel name="bad"><CoordGeom>
            <Line><Start/><End>1 0</End></Line>
            <Line><Start>0 0</Start><Start>0 0</Start><End>1 0</End></Line>
          </CoordGeom></Parcel>
          <Parcel name="good"><CoordGeom>
            <Line><Start>0 0</Start><End>1 0</End></Line><Line><Start>1 0</Start><End>0 1</End></Line><Line><Start>0 1</Start><End>0 0</End></Line>
          </CoordGeom></Parcel>
        </Parcels>"#,
    ));
    assert_eq!(parsed.cogo_points().len(), 1, "preceding COGO survives");
    assert!(
        parsed.parcels[0].loops.iter().all(Vec::is_empty),
        "only malformed primitives are discarded"
    );
    assert!(matches!(
        parsed.probe_parcel(&parsed.parcels[0]).state,
        LandXmlParcelState::PreservedOnly { .. }
    ));
    assert_eq!(
        parsed.probe_parcel(&parsed.parcels[1]).state,
        LandXmlParcelState::Analytic
    );
}

#[test]
fn issue_5046_refuses_zero_sweep_and_curve_crossing_from_analytic_probe() {
    for boundary in [
        r#"<Curve rot="ccw" radius="1"><Start>1 0</Start><Center>0 0</Center><End>1 0</End></Curve>"#,
        r#"<Curve rot="ccw" radius="1"><Start>1 0</Start><Center>0 0</Center><End>-1 0</End></Curve><Line><Start>-1 0</Start><End>0 2</End></Line><Line><Start>0 2</Start><End>1 0</End></Line>"#,
    ] {
        let parsed = parse(&document(&format!(
            "<Parcels><Parcel><CoordGeom>{boundary}</CoordGeom></Parcel></Parcels>"
        )));
        assert!(matches!(
            parsed.probe_parcel(&parsed.parcels[0]).state,
            LandXmlParcelState::PreservedOnly { .. }
        ));
    }
}

#[test]
fn issue_5046_rejects_small_crossings_and_nonadjacent_repeated_vertices() {
    for boundary in [
        r#"<Line><Start>0 0</Start><End>.003 .003</End></Line><Line><Start>.003 .003</Start><End>0 .003</End></Line><Line><Start>0 .003</Start><End>.002 0</End></Line><Line><Start>.002 0</Start><End>0 0</End></Line>"#,
        r#"<Line><Start>0 0</Start><End>0 2</End></Line><Line><Start>0 2</Start><End>2 2</End></Line><Line><Start>2 2</Start><End>0 0</End></Line><Line><Start>0 0</Start><End>-3 0</End></Line><Line><Start>-3 0</Start><End>-3 -3</End></Line><Line><Start>-3 -3</Start><End>0 0</End></Line>"#,
    ] {
        let parsed = parse(&document(&format!(
            "<Parcels><Parcel><CoordGeom>{boundary}</CoordGeom></Parcel></Parcels>"
        )));
        assert!(matches!(
            parsed.probe_parcel(&parsed.parcels[0]).state,
            LandXmlParcelState::PreservedOnly { .. }
        ));
    }
}

#[test]
fn issue_5046_rebases_huge_finite_parcel_coordinates_and_refuses_overflowed_measurements() {
    let rebased = parse(&document(
        r#"<Parcels><Parcel><CoordGeom><Line><Start>1e100 1e100</Start><End>1.0000000001e100 1e100</End></Line><Line><Start>1.0000000001e100 1e100</Start><End>1.0000000001e100 1.0000000001e100</End></Line><Line><Start>1.0000000001e100 1.0000000001e100</Start><End>1e100 1.0000000001e100</End></Line><Line><Start>1e100 1.0000000001e100</Start><End>1e100 1e100</End></Line></CoordGeom></Parcel></Parcels>"#,
    ));
    let probe = rebased.probe_parcel(&rebased.parcels[0]);
    assert_eq!(probe.state, LandXmlParcelState::Analytic);
    assert!(probe
        .area_in_declared_square_units
        .is_some_and(f64::is_finite));

    let overflowed = parse(&document(
        r#"<Parcels><Parcel><CoordGeom><Line><Start>1e308 1e308</Start><End>-1e308 1e308</End></Line><Line><Start>-1e308 1e308</Start><End>-1e308 -1e308</End></Line><Line><Start>-1e308 -1e308</Start><End>1e308 -1e308</End></Line><Line><Start>1e308 -1e308</Start><End>1e308 1e308</End></Line></CoordGeom></Parcel></Parcels>"#,
    ));
    let probe = overflowed.probe_parcel(&overflowed.parcels[0]);
    assert!(matches!(
        probe.state,
        LandXmlParcelState::PreservedOnly { .. }
    ));
    assert_eq!(probe.perimeter_in_declared_linear_units, None);
    assert_eq!(probe.area_in_declared_square_units, None);
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
        r#"<LandXML xmlns="{LANDXML_12_NAMESPACE}" version="1.2"><Units><Metric linearUnit="meter" areaUnit="hectare"/></Units><Parcels><Parcel area="1"><CoordGeom><Line><Start>0 0</Start><End>100 0</End></Line><Line><Start>100 0</Start><End>100 100</End></Line><Line><Start>100 100</Start><End>0 100</End></Line><Line><Start>0 100</Start><End>0 0</End></Line></CoordGeom></Parcel></Parcels></LandXML>"#
    ));
    let probe = metric.probe_parcel(&metric.parcels[0]);
    assert_eq!(probe.area_in_square_meters, Some(10_000.0));
    assert_eq!(probe.area_in_declared_square_units, Some(1.0));
    assert_eq!(probe.declared_area, Some(1.0));

    let parcel_override = parse(&format!(
        r#"<LandXML xmlns="{LANDXML_12_NAMESPACE}" version="1.2"><Units><Metric linearUnit="meter" areaUnit="squareMeter"/></Units><Parcels><Parcel areaUnit="squareFoot"><CoordGeom><Line><Start>0 0</Start><End>10 0</End></Line><Line><Start>10 0</Start><End>10 10</End></Line><Line><Start>10 10</Start><End>0 10</End></Line><Line><Start>0 10</Start><End>0 0</End></Line></CoordGeom></Parcel></Parcels></LandXML>"#
    ));
    let probe = parcel_override.probe_parcel(&parcel_override.parcels[0]);
    assert_eq!(probe.area_in_square_meters, Some(100.0));
    assert!(
        (probe.area_in_declared_square_units.expect("square feet") - 1_076.391_041_670_972_3).abs()
            < 1e-9
    );

    let missing_linear_units = parse(&format!(
        r#"<LandXML xmlns="{LANDXML_12_NAMESPACE}" version="1.2"><Parcels><Parcel areaUnit="squareFoot"><CoordGeom><Line><Start>0 0</Start><End>10 0</End></Line><Line><Start>10 0</Start><End>10 10</End></Line><Line><Start>10 10</Start><End>0 10</End></Line><Line><Start>0 10</Start><End>0 0</End></Line></CoordGeom></Parcel></Parcels></LandXML>"#
    ));
    assert!(matches!(
        missing_linear_units
            .probe_parcel(&missing_linear_units.parcels[0])
            .state,
        LandXmlParcelState::PreservedOnly { .. }
    ));
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
fn issue_5046_rejects_irregular_crossings_and_reference_cycles() {
    let crossing = parse(&document(
        r#"<Parcels><Parcel name="cross"><CoordGeom><IrregularLine><Start>0 0</Start><PntList2D>2 2 0 2</PntList2D><End>2 0</End></IrregularLine><Line><Start>2 0</Start><End>0 0</End></Line></CoordGeom></Parcel></Parcels>"#,
    ));
    assert!(matches!(
        crossing.probe_parcel(&crossing.parcels[0]).state,
        LandXmlParcelState::PreservedOnly { .. }
    ));
    let aliases = parse(&document(
        r#"<CgPoints><CgPoint name="base">4 5</CgPoint><CgPoint name="named-alias" pntRef="base"/><CgPoint name="indexed" pntRef="1"/><CgPoint name="a" pntRef="b"/><CgPoint name="b" pntRef="a"/></CgPoints>"#,
    ));
    let reference = |name: &str| ifc_lite_landxml::LandXmlPlanPointLocation::PointReference {
        pnt_ref: name.to_owned(),
    };
    assert_eq!(
        aliases
            .resolve_point(None, &reference("named-alias"))
            .expect("authored name ref")
            .northing,
        4.0
    );
    assert_eq!(aliases.resolve_point(None, &reference("indexed")), None);
    assert_eq!(aliases.resolve_point(None, &reference("a")), None);
}

#[test]
fn issue_5046_keeps_nested_cgpoints_and_ignores_foreign_wrapper_descendants() {
    let parsed = parse(&document(
        r#"<CgPoints><CgPoint name="outer">1 2</CgPoint><CgPoints><CgPoint name="inner">3 4</CgPoint></CgPoints></CgPoints>
        <CgPoints><CgPoint name="safe">5 6</CgPoint></CgPoints>
        <PlanFeatures><PlanFeature name="safe"><vendor:Wrapper xmlns:vendor="urn:vendor"><Location>9 9</Location><CoordGeom><Line><Start>0 0</Start><End>1 1</End></Line></CoordGeom></vendor:Wrapper></PlanFeature></PlanFeatures>"#,
    ));
    assert_eq!(parsed.cogo_points().len(), 3);
    assert_eq!(parsed.cogo_points()[1].point.expect("inner").northing, 3.0);
    assert_eq!(parsed.cogo_points()[2].point.expect("safe").easting, 6.0);
    assert!(parsed.plan_features[0].locations.is_empty());
    assert!(parsed.plan_features[0].geometry.is_empty());
}

#[test]
fn issue_5046_batches_without_usize_capacity_overflow_and_cancels_alias_work() {
    let parsed = parse(&document(
        r#"<CgPoints><CgPoint name="base">1 2</CgPoint><CgPoint name="alias-a" pntRef="base"/><CgPoint name="alias-b" pntRef="alias-a"/></CgPoints>"#,
    ));
    let batches = parsed.source_batches(usize::MAX);
    assert_eq!(batches.len(), 1);
    assert_eq!(batches[0].source_ids.len(), 3);

    struct CancelAfter(AtomicUsize);
    impl LandXmlCancellation for CancelAfter {
        fn is_cancelled(&self) -> bool {
            self.0.fetch_add(1, Ordering::Relaxed) >= 1
        }
    }
    let cancellation = CancelAfter(AtomicUsize::new(0));
    let result = parsed.resolve_point_with_cancel(
        None,
        &ifc_lite_landxml::LandXmlPlanPointLocation::PointReference {
            pnt_ref: "alias-b".to_owned(),
        },
        Some(&cancellation),
    );
    assert_eq!(
        result
            .expect_err("alias traversal must poll cancellation")
            .code,
        LandXmlDiagnosticCode::Cancelled
    );
}

#[test]
fn issue_5046_does_not_adopt_foreign_plan_descendants_or_scopes() {
    let parsed = parse(&document(
        r#"<Wrapper><CgPoints><CgPoints><CgPoint name="foreign">7 8</CgPoint></CgPoints></CgPoints></Wrapper>
        <PlanFeatures><PlanFeature name="safe"><Wrapper><Property label="foreign" value="no"/></Wrapper><Property label="safe" value="yes"/></PlanFeature></PlanFeatures>
        <Parcels><Parcel name="safe"><Wrapper><Title name="foreign"/></Wrapper><Title name="safe"/></Parcel></Parcels>"#,
    ));
    assert!(parsed.cogo_points().is_empty());
    assert_eq!(
        parsed.plan_features[0].properties.get("safe"),
        Some(&"yes".to_owned())
    );
    assert!(!parsed.plan_features[0].properties.contains_key("foreign"));
    assert_eq!(parsed.parcels[0].title.as_deref(), Some("safe"));
}

#[test]
fn issue_5046_bounds_curve_center_aliases_and_rebuilds_safe_lookup_after_deserialize() {
    let mut aliases = String::from(r#"<CgPoints><CgPoint name="a0">0 0</CgPoint>"#);
    for ordinal in 1..=5_000 {
        aliases.push_str(&format!(
            r#"<CgPoint name="a{ordinal}" pntRef="a{}"/>"#,
            ordinal - 1
        ));
    }
    aliases.push_str("</CgPoints>");
    let parsed = parse(&document(&format!(
        r#"{aliases}<Parcels><Parcel><CoordGeom><Curve rot="ccw" radius="1"><Start>1 0</Start><Center pntRef="a5000"/><End>-1 0</End></Curve><Line><Start>-1 0</Start><End>1 0</End></Line></CoordGeom></Parcel></Parcels>"#
    )));
    assert_eq!(
        parsed
            .probe_parcel_with_cancel(&parsed.parcels[0], 20, None)
            .expect_err("curve center aliases consume topology budget")
            .code,
        LandXmlDiagnosticCode::LimitExceeded
    );

    let source = parse(&document(
        r#"<CgPoints><CgPoint name="2">9 9</CgPoint><CgPoint name="3">1 2</CgPoint><CgPoint name="alias-two" pntRef="2"/><CgPoint name="alias-three" pntRef="3"/></CgPoints>"#,
    ));
    let restored: ifc_lite_landxml::LandXmlPlanDocument =
        serde_json::from_str(&serde_json::to_string(&source).expect("serialize"))
            .expect("deserialize plan records");
    let reference = ifc_lite_landxml::LandXmlPlanPointLocation::PointReference {
        pnt_ref: "alias-two".to_owned(),
    };
    assert_eq!(
        restored
            .resolve_point(None, &reference)
            .expect("alias resolves")
            .northing,
        9.0
    );

    let mut mutated = source.clone();
    let mut replacement = source.cogo_points().to_vec();
    replacement.swap(0, 1);
    replacement[1].name = Some("renamed".to_owned());
    mutated.replace_cogo_points(replacement);
    assert_eq!(
        mutated
            .resolve_point(
                None,
                &ifc_lite_landxml::LandXmlPlanPointLocation::PointReference {
                    pnt_ref: "renamed".to_owned(),
                },
            )
            .expect("renamed public point resolves"),
        source.cogo_points()[0].point.expect("authored point")
    );
    let mut zero_ordinal = source;
    let mut replacement = zero_ordinal.cogo_points().to_vec();
    replacement[0].ordinal = 0;
    zero_ordinal.replace_cogo_points(replacement);
    let restored: ifc_lite_landxml::LandXmlPlanDocument =
        serde_json::from_str(&serde_json::to_string(&zero_ordinal).expect("serialize"))
            .expect("deserialize zero ordinal");
    assert_eq!(
        restored
            .resolve_point(None, &reference)
            .expect("authored name survives"),
        zero_ordinal.cogo_points()[0].point.expect("authored point")
    );
}

#[test]
fn issue_5046_bulk_parcel_probes_share_alias_cache_and_one_operation_budget() {
    // This is deliberately an operation-count invariant, not a timing test:
    // every parcel reaches the same 1,024-hop alias. Without document-scoped
    // path compression that is quadratic alias work before topology begins.
    let count = 1_024;
    let parsed = parse(&aliased_triangle_parcels(count));
    let mut resolver = LandXmlPlanResolver::new(&parsed, count * 32);
    let probes = parsed
        .probe_parcels_with_resolver(&parsed.parcels, &mut resolver)
        .expect("one aggregate budget accepts cached aliases and triangle topology");
    assert_eq!(probes.len(), count);
    assert!(probes
        .iter()
        .all(|probe| probe.state == LandXmlParcelState::Analytic));
    assert!(
        resolver.work_used() <= count * 32,
        "cached bulk parcels must remain linear in aliases plus parcel topology; used {} operations",
        resolver.work_used()
    );

    let mut exhausted = LandXmlPlanResolver::new(&parsed, count);
    assert_eq!(
        parsed
            .probe_parcels_with_resolver(&parsed.parcels, &mut exhausted)
            .expect_err("the one shared budget, not a per-parcel reset, must exhaust")
            .code,
        LandXmlDiagnosticCode::LimitExceeded
    );
}

#[test]
fn issue_5046_bulk_parcel_probes_preserve_scoped_dangling_and_cyclic_references() {
    let parsed = parse(&document(
        r#"
        <CgPoints><CgPoint name="shared">0 0</CgPoint></CgPoints>
        <Parcels><Parcel name="first"><CoordGeom><Line><Start pntRef="shared"/><End>1 0</End></Line><Line><Start>1 0</Start><End>0 1</End></Line><Line><Start>0 1</Start><End pntRef="shared"/></Line></CoordGeom></Parcel></Parcels>
        <CgPoints><CgPoint name="shared">10 10</CgPoint><CgPoint name="cycle-a" pntRef="cycle-b"/><CgPoint name="cycle-b" pntRef="cycle-a"/></CgPoints>
        <Parcels>
          <Parcel name="second"><CoordGeom><Line><Start pntRef="shared"/><End>11 10</End></Line><Line><Start>11 10</Start><End>10 11</End></Line><Line><Start>10 11</Start><End pntRef="shared"/></Line></CoordGeom></Parcel>
          <Parcel name="cycle"><CoordGeom><Line><Start pntRef="cycle-a"/><End>1 0</End></Line></CoordGeom></Parcel>
          <Parcel name="dangling"><CoordGeom><Line><Start pntRef="missing"/><End>1 0</End></Line></CoordGeom></Parcel>
        </Parcels>
    "#,
    ));
    let mut resolver = LandXmlPlanResolver::new(&parsed, 10_000);
    let probes = parsed
        .probe_parcels_with_resolver(&parsed.parcels, &mut resolver)
        .expect("unresolved parcel evidence is preserved, not a document error");
    assert_eq!(probes[0].state, LandXmlParcelState::Analytic);
    assert_eq!(probes[1].state, LandXmlParcelState::Analytic);
    for probe in &probes[2..] {
        assert_eq!(
            probe.state,
            LandXmlParcelState::PreservedOnly {
                reason: "open or unresolved boundary".to_owned(),
            }
        );
    }
}

#[test]
fn issue_5046_bulk_topology_supports_production_sized_regular_line_parcels() {
    for edges in [76, 100, 128] {
        let parsed = parse(&document(&format!(
            "<Parcels>{}</Parcels>",
            regular_line_parcel(edges, "regular")
        )));
        let mut resolver = LandXmlPlanResolver::new(&parsed, 10_000);
        let probe = parsed
            .probe_parcels_with_resolver(&parsed.parcels, &mut resolver)
            .expect("a supported regular boundary must not exhaust document resolution")
            .pop()
            .expect("one parcel probe");
        assert_eq!(probe.state, LandXmlParcelState::Analytic, "{edges} edges");
        assert!(
            probe
                .area_in_declared_square_units
                .is_some_and(f64::is_finite),
            "{edges} edges retain analytic area"
        );
    }
}

#[test]
fn issue_5046_bulk_topology_limit_preserves_one_parcel_without_starving_siblings() {
    let parsed = parse(&document(&format!(
        r#"<CgPoints><CgPoint name="safe">2 3</CgPoint></CgPoints>
        <Monuments><Monument pntRef="safe"/></Monuments><Parcels>{}<Parcel name="safe"><CoordGeom>
        <Line><Start pntRef="safe"/><End>3 3</End></Line><Line><Start>3 3</Start><End>2 4</End></Line><Line><Start>2 4</Start><End pntRef="safe"/></Line>
        </CoordGeom></Parcel></Parcels>"#,
        regular_line_parcel(701, "over-limit")
    )));
    let mut resolver = LandXmlPlanResolver::new(&parsed, 10_000);
    let probes = parsed
        .probe_parcels_with_resolver(&parsed.parcels, &mut resolver)
        .expect("one complex parcel is a local preservation result");
    assert_eq!(
        parsed.cogo_points()[0].point.expect("safe COGO").northing,
        2.0
    );
    assert_eq!(
        probes[0].state,
        LandXmlParcelState::PreservedOnly {
            reason: "parcel topology work limit exceeded".to_owned(),
        }
    );
    assert_eq!(probes[1].state, LandXmlParcelState::Analytic);
    assert_eq!(
        resolver
            .resolve(
                None,
                &ifc_lite_landxml::LandXmlPlanPointLocation::PointReference {
                    pnt_ref: "safe".to_owned(),
                }
            )
            .expect("resolver remains usable")
            .expect("safe COGO resolves")
            .easting,
        3.0
    );
}

#[test]
fn issue_5046_never_fabricates_multi_loop_curve_topology_from_sampled_chords() {
    // The first triangle crosses the circular arc twice between its sampled
    // chord vertices. The near miss, tangent and disjoint cases exercise the
    // same conservative contract until analytic inter-loop curve predicates
    // exist: all remain source-preserved, while the single-loop arc test above
    // continues to prove the supported exact arc-plus-chord measurement.
    let cases = [
        (
            "crossing",
            r#"<Line><Start>0.04895800097771826 0.9986005979070239</Start><End>0.0490774878622835 0.9989952152964134</End></Line><Line><Start>0.0490774878622835 0.9989952152964134</Start><End>0.04915772011680819 0.9985907863348819</End></Line><Line><Start>0.04915772011680819 0.9985907863348819</Start><End>0.04895800097771826 0.9986005979070239</End></Line>"#,
        ),
        (
            "near-miss",
            r#"<Line><Start>0.1 1.1</Start><End>0.2 1.1</End></Line><Line><Start>0.2 1.1</Start><End>0.15 1.2</End></Line><Line><Start>0.15 1.2</Start><End>0.1 1.1</End></Line>"#,
        ),
        (
            "tangent",
            r#"<Line><Start>0 1</Start><End>0.1 1.1</End></Line><Line><Start>0.1 1.1</Start><End>-0.1 1.1</End></Line><Line><Start>-0.1 1.1</Start><End>0 1</End></Line>"#,
        ),
        (
            "disjoint",
            r#"<Line><Start>2 2</Start><End>3 2</End></Line><Line><Start>3 2</Start><End>2 3</End></Line><Line><Start>2 3</Start><End>2 2</End></Line>"#,
        ),
    ];
    for (name, triangle) in cases {
        let parsed = parse(&document(&format!(
            "<Parcels>{}</Parcels>",
            curved_multi_loop_parcel(triangle)
        )));
        let mut resolver = LandXmlPlanResolver::new(&parsed, 10_000);
        let probe = parsed
            .probe_parcels_with_resolver(&parsed.parcels, &mut resolver)
            .expect("conservative curve handling is a record-level result")
            .pop()
            .expect("one parcel");
        assert_eq!(
            probe.state,
            LandXmlParcelState::PreservedOnly {
                reason: "multi-loop boundary with curves".to_owned(),
            },
            "{name} multi-loop curve case"
        );
    }
}

#[test]
fn issue_5046_limits_single_loop_curve_fills_to_an_arc_and_closing_line() {
    let cases = [
        (
            "crossing irregular line",
            r#"<Curve rot="ccw" radius="1"><Start>0 1</Start><Center>0 0</Center><End>0 -1</End></Curve><IrregularLine><Start>0 -1</Start><PntList2D>-2 -1 -2 2 0.0490774878622835 0.9989952152964134 0.04895800097771826 0.9986005979070239</PntList2D><End>0 1</End></IrregularLine>"#,
        ),
        (
            "near-miss irregular line",
            r#"<Curve rot="ccw" radius="1"><Start>0 1</Start><Center>0 0</Center><End>0 -1</End></Curve><IrregularLine><Start>0 -1</Start><PntList2D>-2 -1 -2 2 -0.1 1.1</PntList2D><End>0 1</End></IrregularLine>"#,
        ),
    ];
    for (name, boundary) in cases {
        let parsed = parse(&document(&format!(
            "<Parcels><Parcel><CoordGeom>{boundary}</CoordGeom></Parcel></Parcels>"
        )));
        let probe = parsed.probe_parcel(&parsed.parcels[0]);
        assert_eq!(
            probe.state,
            LandXmlParcelState::PreservedOnly {
                reason: "unsupported curved boundary topology".to_owned(),
            },
            "{name} must not use sampled curve chords as topology evidence"
        );
        assert_eq!(probe.area_in_declared_square_units, None);
        assert_eq!(probe.perimeter_in_declared_linear_units, None);
    }

    let reversed = parse(&document(
        r#"<Parcels><Parcel><CoordGeom>
          <Line><Start>0 1</Start><End>0 -1</End></Line>
          <Curve rot="cw" radius="1"><Start>0 -1</Start><Center>0 0</Center><End>0 1</End></Curve>
        </CoordGeom></Parcel></Parcels>"#,
    ));
    assert_eq!(
        reversed.probe_parcel(&reversed.parcels[0]).state,
        LandXmlParcelState::Analytic,
        "the exact arc-plus-chord loop accepts reversed authored order"
    );
}

#[test]
fn issue_5046_deserialized_reference_index_is_polled_once_and_retained() {
    let mut points = String::from("<CgPoints>");
    for ordinal in 0..100_000 {
        points.push_str(&format!(
            r#"<CgPoint name="p{ordinal}">{ordinal} 0</CgPoint>"#
        ));
    }
    points.push_str("</CgPoints>");
    let source = parse(&document(&points));
    let restored: ifc_lite_landxml::LandXmlPlanDocument =
        serde_json::from_str(&serde_json::to_string(&source).expect("serialize large plan"))
            .expect("deserialize large plan");
    let reference = ifc_lite_landxml::LandXmlPlanPointLocation::PointReference {
        pnt_ref: "p99999".to_owned(),
    };

    struct CancelOnThirdPoll(AtomicUsize);
    impl LandXmlCancellation for CancelOnThirdPoll {
        fn is_cancelled(&self) -> bool {
            self.0.fetch_add(1, Ordering::Relaxed) >= 2
        }
    }

    let interrupted = CancelOnThirdPoll(AtomicUsize::new(0));
    assert_eq!(
        restored
            .resolve_point_with_cancel(None, &reference, Some(&interrupted))
            .expect_err("deserialized index rebuild must poll cancellation")
            .code,
        LandXmlDiagnosticCode::Cancelled
    );
    assert!(
        interrupted.0.load(Ordering::Relaxed) >= 3,
        "cancellation occurred during the index rebuild"
    );

    assert_eq!(
        restored
            .resolve_point(None, &reference)
            .expect("first uncancelled lookup builds the cache")
            .northing,
        99_999.0
    );
    let retained = CancelOnThirdPoll(AtomicUsize::new(0));
    assert_eq!(
        restored
            .resolve_point_with_cancel(None, &reference, Some(&retained))
            .expect("cached lookup must not rebuild the 100k-point index")
            .expect("cached point"),
        ifc_lite_landxml::LandXmlPlanPoint {
            northing: 99_999.0,
            easting: 0.0,
            elevation: None,
        }
    );
    assert_eq!(
        retained.0.load(Ordering::Relaxed),
        1,
        "only the reference traversal, not a second index rebuild, was polled"
    );
    let missing = CancelOnThirdPoll(AtomicUsize::new(0));
    assert_eq!(
        restored
            .resolve_point_with_cancel(
                None,
                &ifc_lite_landxml::LandXmlPlanPointLocation::PointReference {
                    pnt_ref: "missing".to_owned(),
                },
                Some(&missing),
            )
            .expect("missing lookup remains indexed"),
        None,
    );
    assert_eq!(
        missing.0.load(Ordering::Relaxed),
        1,
        "a missing COGO reference must not fall back to an unbounded scan"
    );
}

#[test]
fn issue_5046_invalidates_reference_index_for_renames_duplicate_appends_and_scope_moves() {
    let source = parse(&document(
        r#"<CgPoints><CgPoint name="one">1 0</CgPoint></CgPoints><CgPoints><CgPoint name="two">2 0</CgPoint></CgPoints>"#,
    ));
    let reference = |name: &str| ifc_lite_landxml::LandXmlPlanPointLocation::PointReference {
        pnt_ref: name.to_owned(),
    };
    assert_eq!(
        source
            .resolve_point(None, &reference("one"))
            .expect("original")
            .northing,
        1.0
    );

    let mut renamed = source.clone();
    let mut records = renamed.cogo_points().to_vec();
    records[0].name = Some("renamed".to_owned());
    renamed.replace_cogo_points(records);
    assert_eq!(renamed.resolve_point(None, &reference("one")), None);
    assert_eq!(
        renamed
            .resolve_point(None, &reference("renamed"))
            .expect("rename")
            .northing,
        1.0
    );

    let mut duplicate = renamed.clone();
    let mut records = duplicate.cogo_points().to_vec();
    let mut duplicate_record = records[0].clone();
    duplicate_record.source_id.0 = "landxml:CgPoint:3:renamed-copy".to_owned();
    duplicate_record.ordinal = 3;
    records.push(duplicate_record);
    duplicate.replace_cogo_points(records);
    assert_eq!(
        duplicate.resolve_point(None, &reference("renamed")),
        None,
        "duplicate authored names are ambiguous"
    );

    let mut moved = parse(&document(
        r#"<CgPoints><CgPoint name="scoped">1 0</CgPoint></CgPoints><CgPoints><CgPoint name="scoped">2 0</CgPoint></CgPoints>"#,
    ));
    let first_scope = moved.cogo_points()[0].scope_id.clone();
    let second_scope = moved.cogo_points()[1].scope_id.clone();
    let mut records = moved.cogo_points().to_vec();
    records[0].scope_id = second_scope.clone();
    moved.replace_cogo_points(records);
    assert_eq!(
        moved.resolve_point(Some(&first_scope), &reference("scoped")),
        None
    );
    assert_eq!(
        moved.resolve_point(Some(&second_scope), &reference("scoped")),
        None,
        "moved duplicate is ambiguous in its new scope"
    );
}

#[test]
fn issue_5046_resolves_only_authored_cogo_names_and_unambiguous_global_fallback() {
    let source = parse(&document(
        r#"<CgPoints><CgPoint name="origin">1 2</CgPoint></CgPoints><CgPoints><CgPoint name="local">3 4</CgPoint></CgPoints><PlanFeatures><PlanFeature><CoordGeom><Line><Start pntRef="origin"/><End>5 6</End></Line></CoordGeom></PlanFeature></PlanFeatures>"#,
    ));
    let geometry = &source.plan_features[0].geometry[0];
    assert_eq!(
        source
            .resolve_point(geometry.point_scope_id.as_ref(), &geometry.start)
            .expect("unique global fallback")
            .northing,
        1.0
    );
    let internal = ifc_lite_landxml::LandXmlPlanPointLocation::PointReference {
        pnt_ref: source.cogo_points()[0].source_id.0.clone(),
    };
    assert_eq!(
        source.resolve_point(None, &internal),
        None,
        "synthetic source ids are never authored pntRef values"
    );
}

#[test]
fn issue_5046_treats_cdata_as_literal_and_rejects_nested_numeric_content() {
    let literal =
        document(r#"<CgPoints><CgPoint name="bad"><![CDATA[&#49; 2]]></CgPoint></CgPoints>"#);
    assert_eq!(
        parse_landxml_plan_with_cancel(literal.as_bytes(), &LandXmlPlanLimits::default(), None)
            .expect_err("CDATA entities must remain literal")
            .code,
        LandXmlDiagnosticCode::InvalidSemantic,
    );
    let nested = document(r#"<CgPoints><CgPoint name="bad">1<Feature/>2</CgPoint></CgPoints>"#);
    assert_eq!(
        parse_landxml_plan_with_cancel(nested.as_bytes(), &LandXmlPlanLimits::default(), None)
            .expect_err("nested numeric capture must be refused")
            .code,
        LandXmlDiagnosticCode::InvalidSemantic,
    );
}

#[test]
fn issue_5046_does_not_adopt_nested_parcels_through_foreign_wrappers() {
    let parsed = parse(&document(
        r#"<Parcels><Parcel name="safe"><vendor:Wrapper xmlns:vendor="urn:vendor"><Parcels><Parcel name="foreign"/></Parcels></vendor:Wrapper><Parcels><Parcel name="inner"/></Parcels></Parcel></Parcels>"#,
    ));
    assert_eq!(parsed.parcels.len(), 2);
    assert_eq!(parsed.parcels[0].name.as_deref(), Some("inner"));
    assert_eq!(parsed.parcels[1].name.as_deref(), Some("safe"));
}
