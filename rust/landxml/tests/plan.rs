/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

use ifc_lite_landxml::{
    parse_landxml_document, parse_landxml_plan_with_cancel, LandXmlCancellation,
    LandXmlCancellationFlag, LandXmlDiagnosticCode, LandXmlParcelState, LandXmlPlanLimits,
    LANDXML_12_NAMESPACE,
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
