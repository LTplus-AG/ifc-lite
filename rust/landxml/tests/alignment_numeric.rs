// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use ifc_lite_landxml::alignment::{
    LandXmlAlignment, LandXmlAlignmentPrimitive, LandXmlAlignmentSegment, LandXmlCant,
    LandXmlCantStation, LandXmlCurve, LandXmlIrregularLine, LandXmlLine, LandXmlPlanPoint,
    LandXmlPointLocation, LandXmlRadius, LandXmlRotation, LandXmlSpiral, LandXmlStationEquation,
    LandXmlSuperelevation, LandXmlSuperelevationEvent, LandXmlSuperelevationEventKind,
};
use ifc_lite_landxml::LandXmlSourceId;

fn id(value: &str) -> LandXmlSourceId {
    LandXmlSourceId(value.to_owned())
}

fn point(northing: f64, easting: f64) -> LandXmlPointLocation {
    LandXmlPointLocation::Coordinates {
        point: LandXmlPlanPoint {
            northing,
            easting,
            elevation: None,
        },
    }
}

fn alignment(segments: Vec<LandXmlAlignmentSegment>, length: f64) -> LandXmlAlignment {
    LandXmlAlignment {
        source_id: id("landxml:alignment:1:main"),
        ordinal: 1,
        name: "main".to_owned(),
        length,
        sta_start: 100.0,
        start: None,
        segments,
        station_equations: Vec::new(),
        cant: None,
        superelevations: Vec::new(),
        unsupported_transitions: Vec::new(),
    }
}

#[test]
fn issue_5044_line_has_endpoint_interior_tangent_and_source_id_probe() {
    let line = LandXmlAlignmentSegment {
        source_id: id("landxml:alignment:1:segment:1"),
        ordinal: 1,
        primitive: LandXmlAlignmentPrimitive::Line(LandXmlLine {
            start: point(0.0, 0.0),
            end: point(10.0, 0.0),
            declared_length: Some(10.0),
        }),
    };
    let alignment = alignment(vec![line], 10.0);
    let interior = alignment
        .probe_at_distance(5.0, 2.0)
        .expect("interior probe");
    assert_eq!(
        interior.segment_source_id.0,
        "landxml:alignment:1:segment:1"
    );
    assert_eq!((interior.northing, interior.easting), (5.0, 2.0));
    assert_eq!(
        (interior.tangent_northing, interior.tangent_easting),
        (1.0, 0.0)
    );
    let endpoint = alignment
        .probe_at_distance(10.0, 0.0)
        .expect("endpoint probe");
    assert_eq!((endpoint.northing, endpoint.easting), (10.0, 0.0));
    assert_eq!(
        (endpoint.tangent_northing, endpoint.tangent_easting),
        (1.0, 0.0)
    );
}

#[test]
fn issue_5044_arc_has_independent_interior_and_tangent_probe() {
    let quarter = std::f64::consts::FRAC_PI_2 * 10.0;
    let curve = LandXmlAlignmentSegment {
        source_id: id("landxml:alignment:1:segment:arc"),
        ordinal: 1,
        primitive: LandXmlAlignmentPrimitive::Curve(LandXmlCurve {
            start: point(10.0, 0.0),
            center: point(0.0, 0.0),
            end: point(0.0, 10.0),
            pi: Some(point(10.0, 10.0)),
            rotation: LandXmlRotation::CounterClockwise,
            radius: Some(10.0),
            declared_length: Some(quarter),
        }),
    };
    let alignment = alignment(vec![curve], quarter);
    let midpoint = alignment
        .probe_at_distance(quarter / 2.0, 0.0)
        .expect("arc midpoint");
    assert!((midpoint.northing - 2.0_f64.sqrt() * 5.0).abs() < 1e-9);
    assert!((midpoint.easting - 2.0_f64.sqrt() * 5.0).abs() < 1e-9);
    assert!((midpoint.tangent_northing + 2.0_f64.sqrt() / 2.0).abs() < 1e-9);
    assert!((midpoint.tangent_easting - 2.0_f64.sqrt() / 2.0).abs() < 1e-9);
    let end = alignment
        .probe_at_distance(quarter, 0.0)
        .expect("arc endpoint");
    assert!((end.northing - 0.0).abs() < 1e-9 && (end.easting - 10.0).abs() < 1e-9);
}

#[test]
fn issue_5044_irregular_line_preserves_intermediate_vertices() {
    let irregular = LandXmlAlignmentSegment {
        source_id: id("landxml:alignment:1:segment:irregular"),
        ordinal: 1,
        primitive: LandXmlAlignmentPrimitive::IrregularLine(LandXmlIrregularLine {
            start: point(0.0, 0.0),
            end: point(10.0, 10.0),
            points: vec![LandXmlPlanPoint {
                northing: 0.0,
                easting: 10.0,
                elevation: None,
            }],
            declared_length: Some(20.0),
        }),
    };
    let alignment = alignment(vec![irregular], 20.0);
    let interior = alignment
        .probe_at_distance(15.0, 0.0)
        .expect("irregular interior");
    assert_eq!((interior.northing, interior.easting), (5.0, 10.0));
    assert_eq!(
        (interior.tangent_northing, interior.tangent_easting),
        (1.0, 0.0)
    );
    let endpoint = alignment
        .probe_at_distance(20.0, 0.0)
        .expect("irregular endpoint");
    assert_eq!((endpoint.northing, endpoint.easting), (10.0, 10.0));
    assert_eq!(
        (endpoint.tangent_northing, endpoint.tangent_easting),
        (1.0, 0.0)
    );
}

#[test]
fn issue_5044_clothoid_endpoint_and_interior_probes_are_deterministic() {
    let spiral = LandXmlAlignmentSegment {
        source_id: id("landxml:alignment:1:segment:spiral"),
        ordinal: 1,
        primitive: LandXmlAlignmentPrimitive::Spiral(LandXmlSpiral {
            start: point(0.0, 0.0),
            pi: point(40.0, 5.0),
            end: point(99.0, 12.0),
            spi_type: "clothoid".to_owned(),
            radius_start: LandXmlRadius::Infinite,
            radius_end: LandXmlRadius::Finite(200.0),
            rotation: LandXmlRotation::CounterClockwise,
            declared_length: 100.0,
        }),
    };
    let alignment = alignment(vec![spiral], 100.0);
    let first = alignment
        .probe_at_distance(50.0, 0.0)
        .expect("spiral interior");
    let second = alignment
        .probe_at_distance(50.0, 0.0)
        .expect("repeat spiral interior");
    assert_eq!(first, second);
    let end = alignment
        .probe_at_distance(100.0, 0.0)
        .expect("spiral endpoint");
    assert_eq!((end.northing, end.easting), (99.0, 12.0));
    assert!((first.tangent_northing.hypot(first.tangent_easting) - 1.0).abs() < 1e-12);
    assert!((end.tangent_northing.hypot(end.tangent_easting) - 1.0).abs() < 1e-12);
}

#[test]
fn issue_5044_station_equations_keep_gaps_and_duplicate_labels_explicit() {
    let line = LandXmlAlignmentSegment {
        source_id: id("landxml:alignment:1:segment:1"),
        ordinal: 1,
        primitive: LandXmlAlignmentPrimitive::Line(LandXmlLine {
            start: point(0.0, 0.0),
            end: point(100.0, 0.0),
            declared_length: Some(100.0),
        }),
    };
    let mut alignment = alignment(vec![line], 100.0);
    alignment.station_equations = vec![
        LandXmlStationEquation {
            source_id: id("eq:1"),
            sta_internal: 150.0,
            sta_ahead: 200.0,
            sta_back: Some(150.0),
            sta_increment: Some("increasing".to_owned()),
        },
        LandXmlStationEquation {
            source_id: id("eq:2"),
            sta_internal: 170.0,
            sta_ahead: 200.0,
            sta_back: Some(220.0),
            sta_increment: Some("increasing".to_owned()),
        },
    ];
    let boundary = alignment
        .station_at_distance(50.0)
        .expect("equation boundary");
    assert!(boundary.is_equation_boundary);
    assert_eq!(
        (boundary.displayed_back, boundary.displayed_ahead),
        (150.0, 200.0)
    );
    assert!(alignment
        .distances_for_station(180.0)
        .expect("gap lookup")
        .is_empty());
    assert_eq!(
        alignment
            .distances_for_station(200.0)
            .expect("duplicate lookup"),
        vec![50.0, 70.0]
    );
    assert_eq!(
        alignment
            .probe_at_station(200.0, 0.0)
            .expect_err("ambiguous label")
            .code,
        "LXMLA205"
    );
}

#[test]
fn issue_5044_decreasing_station_equation_maps_forward_and_inverse() {
    let line = LandXmlAlignmentSegment {
        source_id: id("line"),
        ordinal: 1,
        primitive: LandXmlAlignmentPrimitive::Line(LandXmlLine {
            start: point(0.0, 0.0),
            end: point(100.0, 0.0),
            declared_length: Some(100.0),
        }),
    };
    let mut alignment = alignment(vec![line], 100.0);
    alignment.station_equations = vec![LandXmlStationEquation {
        source_id: id("eq"),
        sta_internal: 150.0,
        sta_ahead: 500.0,
        sta_back: Some(150.0),
        sta_increment: Some("decreasing".to_owned()),
    }];
    assert_eq!(
        alignment
            .station_at_distance(60.0)
            .expect("forward")
            .displayed_ahead,
        490.0
    );
    assert_eq!(
        alignment.distances_for_station(490.0).expect("inverse"),
        vec![60.0]
    );
}

#[test]
fn issue_5044_non_clothoid_transition_is_never_coerced_to_a_line() {
    let spiral = LandXmlAlignmentSegment {
        source_id: id("landxml:alignment:1:segment:unsupported"),
        ordinal: 1,
        primitive: LandXmlAlignmentPrimitive::Spiral(LandXmlSpiral {
            start: point(0.0, 0.0),
            pi: point(5.0, 0.0),
            end: point(10.0, 0.0),
            spi_type: "bloss".to_owned(),
            radius_start: LandXmlRadius::Infinite,
            radius_end: LandXmlRadius::Finite(50.0),
            rotation: LandXmlRotation::CounterClockwise,
            declared_length: 10.0,
        }),
    };
    let alignment = alignment(vec![spiral], 10.0);
    assert_eq!(
        alignment
            .probe_at_distance(5.0, 0.0)
            .expect_err("unsupported transition")
            .code,
        "LXMLA209"
    );
}

#[test]
fn issue_5044_cant_and_superelevation_are_inspectable_by_internal_station() {
    let line = LandXmlAlignmentSegment {
        source_id: id("landxml:alignment:1:segment:1"),
        ordinal: 1,
        primitive: LandXmlAlignmentPrimitive::Line(LandXmlLine {
            start: point(0.0, 0.0),
            end: point(100.0, 0.0),
            declared_length: Some(100.0),
        }),
    };
    let mut alignment = alignment(vec![line], 100.0);
    alignment.cant = Some(LandXmlCant {
        source_id: id("landxml:alignment:1:cant"),
        name: "rail".to_owned(),
        gauge: 1.435,
        rotation_point: None,
        equilibrium_constant: None,
        applied_cant_constant: None,
        speed_stations: Vec::new(),
        stations: vec![
            LandXmlCantStation {
                source_id: id("cant:1"),
                station: 110.0,
                applied_cant: 20.0,
                equilibrium_cant: None,
                curvature: LandXmlRotation::CounterClockwise,
                cant_deficiency: None,
                cant_excess: None,
                rate_of_change_of_applied_cant_over_time: None,
                rate_of_change_of_applied_cant_over_length: None,
                rate_of_change_of_cant_deficiency_over_time: None,
                cant_gradient: None,
                speed: None,
                transition_type: None,
                adverse: None,
            },
            LandXmlCantStation {
                source_id: id("cant:2"),
                station: 120.0,
                applied_cant: 30.0,
                equilibrium_cant: None,
                curvature: LandXmlRotation::CounterClockwise,
                cant_deficiency: None,
                cant_excess: None,
                rate_of_change_of_applied_cant_over_time: None,
                rate_of_change_of_applied_cant_over_length: None,
                rate_of_change_of_cant_deficiency_over_time: None,
                cant_gradient: None,
                speed: None,
                transition_type: None,
                adverse: None,
            },
        ],
    });
    alignment.superelevations = vec![LandXmlSuperelevation {
        source_id: id("se:1"),
        sta_start: Some(110.0),
        sta_end: Some(130.0),
        events: vec![LandXmlSuperelevationEvent {
            source_id: id("se:1:event:1"),
            kind: LandXmlSuperelevationEventKind::FullSuperelev,
            value: Some("0.06".to_owned()),
        }],
    }];
    let cant = alignment
        .cant_at_distance(15.0)
        .expect("cant probe")
        .expect("cant source");
    assert_eq!(cant.previous.expect("previous").applied_cant, 20.0);
    assert_eq!(cant.next.expect("next").applied_cant, 30.0);
    let superelevations = alignment
        .superelevations_at_distance(15.0)
        .expect("super probe");
    assert_eq!(superelevations[0].events[0].value.as_deref(), Some("0.06"));
    assert!(alignment
        .superelevations_at_distance(40.0)
        .expect("outside range")
        .is_empty());
}
