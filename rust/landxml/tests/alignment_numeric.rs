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
        align_pis: Vec::new(),
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
            rotation: LandXmlRotation::Clockwise,
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
    let start_right = alignment
        .probe_at_distance(0.0, 2.0)
        .expect("right offset follows N/E handedness");
    assert!((start_right.northing - 8.0).abs() < 1e-12);
    assert!(start_right.easting.abs() < 1e-12);
}

#[test]
fn issue_5044_irregular_line_preserves_intermediate_vertices() {
    let irregular = LandXmlAlignmentSegment {
        source_id: id("landxml:alignment:1:segment:irregular"),
        ordinal: 1,
        primitive: LandXmlAlignmentPrimitive::IrregularLine(LandXmlIrregularLine {
            start: point(0.0, 0.0),
            end: point(10.0, 10.0),
            points: vec![
                LandXmlPlanPoint {
                    northing: 0.0,
                    easting: 0.0,
                    elevation: None,
                },
                LandXmlPlanPoint {
                    northing: 0.0,
                    easting: 10.0,
                    elevation: None,
                },
                LandXmlPlanPoint {
                    northing: 10.0,
                    easting: 10.0,
                    elevation: None,
                },
            ],
            declared_length: None,
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
    let start = alignment
        .probe_at_distance(0.0, 0.0)
        .expect("schema PntList endpoints are de-duplicated");
    assert_eq!((start.northing, start.easting), (0.0, 0.0));
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
fn issue_5044_clothoid_uses_validated_pi_and_independent_numeric_oracle() {
    let spiral = LandXmlAlignmentSegment {
        source_id: id("landxml:alignment:1:segment:spiral"),
        ordinal: 1,
        primitive: LandXmlAlignmentPrimitive::Spiral(LandXmlSpiral {
            start: point(0.0, 0.0),
            // These values are independently integrated from
            // theta(s) = 0.0001 * s^2, in conventional E/N axes.
            pi: point(0.0, 70.530_325_240_5),
            end: point(31.026_830_172_3, 90.452_423_790_0),
            spi_type: "clothoid".to_owned(),
            radius_start: LandXmlRadius::Infinite,
            radius_end: LandXmlRadius::Finite(50.0),
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
    assert_eq!(first, second, "deterministic quadrature");
    assert!((first.northing - 4.148_102_426_85).abs() < 1e-8);
    assert!((first.easting - 49.688_402_921_5).abs() < 1e-8);
    assert!((first.tangent_northing - 0.247_403_959_25).abs() < 1e-9);
    assert!((first.tangent_easting - 0.968_912_421_71).abs() < 1e-9);
    let end = alignment
        .probe_at_distance(100.0, 0.0)
        .expect("spiral endpoint");
    assert!((end.northing - 31.026_830_172_3).abs() < 1e-8);
    assert!((end.easting - 90.452_423_790_0).abs() < 1e-8);
    assert!((first.tangent_northing.hypot(first.tangent_easting) - 1.0).abs() < 1e-12);
    assert!((end.tangent_northing.hypot(end.tangent_easting) - 1.0).abs() < 1e-12);
}

#[test]
fn issue_5044_clothoid_refuses_invented_endpoint_or_pi_tangent() {
    let valid = LandXmlSpiral {
        start: point(0.0, 0.0),
        pi: point(0.0, 70.530_325_240_5),
        end: point(31.026_830_172_3, 90.452_423_790_0),
        spi_type: "clothoid".to_owned(),
        radius_start: LandXmlRadius::Infinite,
        radius_end: LandXmlRadius::Finite(50.0),
        rotation: LandXmlRotation::CounterClockwise,
        declared_length: 100.0,
    };
    let endpoint_error = alignment(
        vec![LandXmlAlignmentSegment {
            source_id: id("bad-end"),
            ordinal: 1,
            primitive: LandXmlAlignmentPrimitive::Spiral(LandXmlSpiral {
                end: point(31.026_830_172_3, 91.452_423_790_0),
                ..valid.clone()
            }),
        }],
        100.0,
    )
    .probe_at_distance(100.0, 0.0)
    .expect_err("endpoint substitution is forbidden");
    assert_eq!(endpoint_error.code, "LXMLA216");
    let pi_error = alignment(
        vec![LandXmlAlignmentSegment {
            source_id: id("bad-pi"),
            ordinal: 1,
            primitive: LandXmlAlignmentPrimitive::Spiral(LandXmlSpiral {
                pi: point(1.0, 70.530_325_240_5),
                ..valid
            }),
        }],
        100.0,
    )
    .probe_at_distance(100.0, 0.0)
    .expect_err("PI must remain on both endpoint tangents");
    assert_eq!(pi_error.code, "LXMLA217");
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
fn issue_5044_unsupported_transition_keeps_its_span_and_source_identity() {
    let line = |source_id: &str, start: f64, end: f64| LandXmlAlignmentSegment {
        source_id: id(source_id),
        ordinal: 1,
        primitive: LandXmlAlignmentPrimitive::Line(LandXmlLine {
            start: point(start, 0.0),
            end: point(end, 0.0),
            declared_length: Some(end - start),
        }),
    };
    let unsupported = LandXmlAlignmentSegment {
        source_id: id("transition"),
        ordinal: 2,
        primitive: LandXmlAlignmentPrimitive::UnsupportedSpiral(LandXmlSpiral {
            start: point(10.0, 0.0),
            pi: point(15.0, 0.0),
            end: point(20.0, 0.0),
            spi_type: "bloss".to_owned(),
            radius_start: LandXmlRadius::Infinite,
            radius_end: LandXmlRadius::Finite(50.0),
            rotation: LandXmlRotation::CounterClockwise,
            declared_length: 10.0,
        }),
    };
    let alignment = alignment(
        vec![
            line("before", 0.0, 10.0),
            unsupported,
            line("after", 20.0, 30.0),
        ],
        30.0,
    );
    assert_eq!(
        alignment
            .probe_at_distance(15.0, 0.0)
            .expect_err("unsupported span")
            .code,
        "LXMLA209"
    );
    let after = alignment
        .probe_at_distance(25.0, 0.0)
        .expect("post-span line");
    assert_eq!(after.segment_source_id, id("after"));
    assert_eq!((after.northing, after.easting), (25.0, 0.0));
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
