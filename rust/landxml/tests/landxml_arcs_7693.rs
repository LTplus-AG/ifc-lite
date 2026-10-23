// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! EDGE-LXMATH-1 (#7693): one circular-arc rule for alignment curves and
//! parcel edges. Each test states the closed form it holds.

use ifc_lite_landxml::alignment::{
    parse_landxml_alignments_optional_with_cancel, LandXmlAlignmentLimits,
    LandXmlAlignmentPrimitive, LandXmlPointLocation, LandXmlRotation,
};
use ifc_lite_landxml::{
    parse_landxml_plan_with_cancel, LandXmlParcelState, LandXmlPlanLimits, LANDXML_12_NAMESPACE,
};
use std::f64::consts::TAU;

#[path = "../../export/src/test_support.rs"]
#[allow(dead_code, unused_macros)]
// shared with the export unit tests; this file uses `fixture_opt` only
mod test_support;

fn plan_document(body: &str) -> String {
    format!(
        r#"<LandXML xmlns="{LANDXML_12_NAMESPACE}" version="1.2"><Units><Metric linearUnit="meter" areaUnit="squareMeter"/></Units>{body}</LandXML>"#
    )
}

/// A producer file read as the LandXML 1.2 document it is. 3D-Win declares
/// ISO-8859-1 (refused before parsing, #5051) and the InfraModel namespace,
/// but its bytes are ASCII, so only those two labels change.
fn producer_as_landxml_12(path: &str) -> Option<String> {
    let bytes = test_support::fixture_opt(path)?;
    let text = String::from_utf8(bytes).expect("producer fixture is UTF-8 or ASCII");
    Some(
        text.trim_start_matches('\u{feff}')
            .replace(r#"encoding="ISO-8859-1""#, r#"encoding="UTF-8""#)
            .replace("http://www.inframodel.fi/inframodel", LANDXML_12_NAMESPACE),
    )
}

fn alignment_document(coord_geom: &str, length: f64) -> String {
    plan_document(&format!(
        r#"<Alignments><Alignment name="a" length="{length}" staStart="0"><CoordGeom>{coord_geom}</CoordGeom></Alignment></Alignments>"#
    ))
}

/// One real producer arc: Aplitop MDT 8.0's first alignment curve
/// (`tests/models/landxml/producers/aplitop-mdt-8.0-alignment.xml`), at
/// georeferenced magnitude with 6-decimal coordinates. Its centre-to-end
/// distance differs from the radius by 2.7e-7 m.
const APLITOP_ARC: &str = r#"<Curve rot="ccw" radius="25.000000" length="39.840637"><Start>4084593.748632 335095.950465</Start><Center>4084618.730240 335096.909247</Center><End>4084618.341969 335121.906232</End></Curve>"#;
const APLITOP_ARC_START: (f64, f64) = (4084593.748632, 335095.950465);
const APLITOP_ARC_END: (f64, f64) = (4084618.341969, 335121.906232);

fn arc_parcel(arc: &str, start: (f64, f64), end: (f64, f64)) -> String {
    plan_document(&format!(
        r#"<Parcels><Parcel name="arc-and-chord"><CoordGeom>{arc}<Line><Start>{} {}</Start><End>{} {}</End></Line></CoordGeom></Parcel></Parcels>"#,
        end.0, end.1, start.0, start.1
    ))
}

/// EDGE-LXMATH-1 (#7693). Invariant: one circular arc is accepted or
/// refused identically as an alignment Curve and as a parcel edge, and the
/// parcel's arc-plus-chord measures equal the closed forms
/// `perimeter = r·Δ + chord` and `area = r²/2·(Δ − sin Δ)`.
#[test]
fn edge_lxmath_1_real_producer_arc_is_one_arc_in_alignment_and_parcel() {
    let alignment = parse_landxml_alignments_optional_with_cancel(
        alignment_document(APLITOP_ARC, 39.840637).as_bytes(),
        &LandXmlAlignmentLimits::default(),
        None,
    )
    .expect("alignment parses");
    let probe = alignment.alignments[0].probe_at_distance(39.840637, 0.0);
    assert!(probe.is_ok(), "alignment accepts the arc: {probe:?}");

    let plan = parse_landxml_plan_with_cancel(
        arc_parcel(APLITOP_ARC, APLITOP_ARC_START, APLITOP_ARC_END).as_bytes(),
        &LandXmlPlanLimits::default(),
        None,
    )
    .expect("plan parses");
    let parcel = plan.probe_parcel(&plan.parcels[0]);
    assert_eq!(
        parcel.state,
        LandXmlParcelState::Analytic,
        "the same arc must not be refused as a parcel edge"
    );
    let radius = 25.0_f64;
    let sweep = 39.840637 / radius;
    let chord =
        (APLITOP_ARC_END.0 - APLITOP_ARC_START.0).hypot(APLITOP_ARC_END.1 - APLITOP_ARC_START.1);
    let perimeter = parcel
        .perimeter_in_declared_linear_units
        .expect("perimeter");
    let area = parcel.area_in_declared_square_units.expect("area");
    assert!(
        (perimeter - (radius * sweep + chord)).abs() < 1.0e-5,
        "{perimeter}"
    );
    let segment_area = radius * radius / 2.0 * (sweep - sweep.sin());
    assert!(
        (area - segment_area).abs() < 1.0e-4,
        "{area} vs {segment_area}"
    );
}

/// EDGE-LXMATH-1 (#7693). Invariant: the parcel and alignment copies share
/// one sweep rule, so clockwise and counter-clockwise arcs through the same
/// three points close the circle: `area(ccw) + area(cw) = π r²`.
#[test]
fn edge_lxmath_1_cw_and_ccw_parcel_arcs_partition_the_disk() {
    let radius = 37.5_f64;
    let (cn, ce) = (5_200_000.0_f64, 2_600_000.0_f64);
    let point = |angle: f64| (cn + radius * angle.sin(), ce + radius * angle.cos());
    let start = point(0.3);
    let end = point(2.2);
    let area = |rot: &str| {
        let arc = format!(
            r#"<Curve rot="{rot}" radius="{radius}"><Start>{} {}</Start><Center>{cn} {ce}</Center><End>{} {}</End></Curve>"#,
            start.0, start.1, end.0, end.1
        );
        let plan = parse_landxml_plan_with_cancel(
            arc_parcel(&arc, start, end).as_bytes(),
            &LandXmlPlanLimits::default(),
            None,
        )
        .expect("plan parses");
        let probe = plan.probe_parcel(&plan.parcels[0]);
        assert_eq!(probe.state, LandXmlParcelState::Analytic, "{rot}");
        probe.area_in_declared_square_units.expect("area")
    };
    let total = area("ccw") + area("cw");
    assert!(
        (total - TAU / 2.0 * radius * radius).abs() < 1.0e-6,
        "{total}"
    );
}

/// EDGE-LXMATH-1 (#7693), real models: every horizontal `Curve` the three
/// producer alignments carry, closed by its chord, is an analytic parcel
/// whose perimeter is the closed form `r·Δ + chord`.
#[test]
fn edge_lxmath_1_every_real_producer_arc_closes_an_analytic_parcel() {
    let mut checked = 0;
    for path in [
        "landxml/producers/aplitop-mdt-8.0-alignment.xml",
        "landxml/producers/bentley-openroads-designer-10.09-us-survey-foot-alignment.xml",
        "landxml/producers/3d-win-6.6.4-m3-road-alignment.xml",
    ] {
        let Some(xml) = producer_as_landxml_12(path) else {
            continue;
        };
        let document = parse_landxml_alignments_optional_with_cancel(
            xml.as_bytes(),
            &LandXmlAlignmentLimits::default(),
            None,
        )
        .expect("producer alignment parses");
        let curves = document
            .alignments
            .iter()
            .flat_map(|alignment| &alignment.segments);
        for segment in curves {
            let LandXmlAlignmentPrimitive::Curve(curve) = &segment.primitive else {
                continue;
            };
            let point = |location: &LandXmlPointLocation| match location {
                LandXmlPointLocation::Coordinates { point } => (point.northing, point.easting),
                LandXmlPointLocation::PointReference { .. } => panic!("coordinates"),
            };
            let (start, center, end) =
                (point(&curve.start), point(&curve.center), point(&curve.end));
            let radius = curve.radius.expect("producer declares the radius");
            let length = curve.declared_length.expect("producer declares the length");
            let rot = match curve.rotation {
                LandXmlRotation::Clockwise => "cw",
                LandXmlRotation::CounterClockwise => "ccw",
            };
            let arc = format!(
                r#"<Curve rot="{rot}" radius="{radius:?}" length="{length:?}"><Start>{:?} {:?}</Start><Center>{:?} {:?}</Center><End>{:?} {:?}</End></Curve>"#,
                start.0, start.1, center.0, center.1, end.0, end.1
            );
            let plan = parse_landxml_plan_with_cancel(
                arc_parcel(&arc, start, end).as_bytes(),
                &LandXmlPlanLimits::default(),
                None,
            )
            .expect("plan parses");
            let probe = plan.probe_parcel(&plan.parcels[0]);
            assert_eq!(probe.state, LandXmlParcelState::Analytic, "{path}: {arc}");
            let chord = (end.0 - start.0).hypot(end.1 - start.1);
            let perimeter = probe.perimeter_in_declared_linear_units.expect("perimeter");
            let closed_form = length + chord;
            assert!(
                (perimeter - closed_form).abs() <= 1.0e-6 * closed_form,
                "{path}: {perimeter}"
            );
            checked += 1;
        }
    }
    if checked > 0 {
        assert_eq!(checked, 12, "4 Aplitop + 1 OpenRoads + 7 3D-Win curves");
    }
}
