// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! EDGE-LXMATH-9 (#7693): `IrregularLine` evaluation. Each test states the
//! evaluator identity it holds.

use ifc_lite_landxml::alignment::{
    LandXmlAlignment, LandXmlAlignmentPrimitive, LandXmlAlignmentSegment, LandXmlIrregularLine,
    LandXmlLine, LandXmlPlanPoint, LandXmlPointLocation,
};
use ifc_lite_landxml::LandXmlSourceId;

fn source_id(value: &str) -> LandXmlSourceId {
    LandXmlSourceId(value.to_owned())
}

fn at(northing: f64, easting: f64) -> LandXmlPointLocation {
    LandXmlPointLocation::Coordinates {
        point: LandXmlPlanPoint {
            northing,
            easting,
            elevation: None,
        },
    }
}

fn single_segment(primitive: LandXmlAlignmentPrimitive, length: f64) -> LandXmlAlignment {
    LandXmlAlignment {
        source_id: source_id("landxml:alignment:1:a"),
        ordinal: 1,
        name: "a".to_owned(),
        length,
        sta_start: 0.0,
        start: None,
        align_pis: Vec::new(),
        segments: vec![LandXmlAlignmentSegment {
            source_id: source_id("landxml:alignment:1:segment:1"),
            ordinal: 1,
            primitive,
        }],
        station_equations: Vec::new(),
        cant: None,
        superelevations: Vec::new(),
        unsupported_transitions: Vec::new(),
    }
}

/// EDGE-LXMATH-9 (#7693). Invariant: an `IrregularLine` with no interior
/// vertex is a `Line`, so both evaluate identically at every distance up to
/// the declared length, including a declared length the validator accepts
/// as a little longer than the polyline.
#[test]
fn edge_lxmath_9_irregular_line_without_interior_matches_line_through_declared_end() {
    let geometric = 100.0_f64;
    for declared in [geometric, geometric + 5.0e-5, geometric - 5.0e-5] {
        let line = single_segment(
            LandXmlAlignmentPrimitive::Line(LandXmlLine {
                start: at(0.0, 0.0),
                end: at(geometric, 0.0),
                declared_length: Some(declared),
            }),
            declared,
        );
        let irregular = single_segment(
            LandXmlAlignmentPrimitive::IrregularLine(LandXmlIrregularLine {
                start: at(0.0, 0.0),
                end: at(geometric, 0.0),
                points: Vec::new(),
                declared_length: Some(declared),
            }),
            declared,
        );
        for distance in [0.0, 50.0, declared - 1.0e-9, declared] {
            let expected = line.probe_at_distance(distance, 0.0).expect("line probe");
            let actual = irregular
                .probe_at_distance(distance, 0.0)
                .unwrap_or_else(|error| panic!("declared {declared} at {distance}: {error}"));
            assert_eq!(
                (actual.northing, actual.easting),
                (expected.northing, expected.easting),
                "declared {declared} at {distance}"
            );
        }
    }
}

/// EDGE-LXMATH-9 (#7693). Invariant: the end of a multi-vertex irregular
/// line is its authored End, even when the declared length exceeds the
/// polyline by less than the accepted length tolerance.
#[test]
fn edge_lxmath_9_irregular_polyline_end_probe_reaches_authored_end() {
    let polyline = 30.0 + 40.0; // (0,0) -> (30,0) -> (30,40)
    let declared = polyline + 6.0e-5;
    let alignment = single_segment(
        LandXmlAlignmentPrimitive::IrregularLine(LandXmlIrregularLine {
            start: at(0.0, 0.0),
            end: at(30.0, 40.0),
            points: vec![LandXmlPlanPoint {
                northing: 30.0,
                easting: 0.0,
                elevation: None,
            }],
            declared_length: Some(declared),
        }),
        declared,
    );
    let end = alignment
        .probe_at_distance(declared, 0.0)
        .expect("declared end of an accepted irregular line");
    assert_eq!((end.northing, end.easting), (30.0, 40.0));
    assert_eq!((end.tangent_northing, end.tangent_easting), (0.0, 1.0));
}
