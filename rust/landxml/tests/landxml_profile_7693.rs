// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! EDGE-LXMATH-10 (#7693): circular vertical curves. Each test states the
//! closed form or parity rule it holds.

use ifc_lite_landxml::{
    parse_landxml_tin_with_cancel, LandXmlLimits, LandXmlProfileEvaluationError,
    LandXmlVerticalCurveKind, LANDXML_12_NAMESPACE,
};

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

fn profile_document(pvis: &str) -> String {
    plan_document(&format!(
        r#"<Alignments><Alignment name="a" length="2000" staStart="0"><Profile><ProfAlign name="design">{pvis}</ProfAlign></Profile></Alignment></Alignments>"#
    ))
}

fn evaluate_profile(xml: &str, station: f64) -> Result<Option<f64>, LandXmlProfileEvaluationError> {
    let document = parse_landxml_tin_with_cancel(xml.as_bytes(), &LandXmlLimits::default(), None)
        .expect("profile document parses");
    document.profiles[0].evaluate_elevation_at(station)
}

/// EDGE-LXMATH-10 (#7693). Invariant: a circular vertical curve is fixed by
/// its PVI, radius and grades; its declared length is either the arc length
/// `R·|θ₂ − θ₁|` or the horizontal length `R·|sin θ₂ − sin θ₁|` (θ = atan of
/// each grade), rounded as the producer writes it. Both are accepted; a
/// length matching neither is refused. The values are 3D-Win's M3 road
/// profile (6 decimals), whose lengths are arc lengths.
#[test]
fn edge_lxmath_10_rounded_arc_or_horizontal_length_is_accepted() {
    let (s0, e0) = (3.780491_f64, 16.933442_f64);
    let (s1, e1) = (77.651516_f64, 16.564087_f64);
    let (s2, e2) = (143.344365_f64, 18.366885_f64);
    let radius = 1500.0_f64;
    let (t1, t2) = (
        ((e1 - e0) / (s1 - s0)).atan(),
        ((e2 - e1) / (s2 - s1)).atan(),
    );
    let arc = radius * (t2 - t1).abs();
    let horizontal = radius * (t2.sin() - t1.sin()).abs();
    let curve = |length: String| {
        profile_document(&format!(
            r#"<PVI>{s0} {e0}</PVI><CircCurve length="{length}" radius="{radius}">{s1} {e1}</CircCurve><PVI>{s2} {e2}</PVI>"#
        ))
    };
    // The producer's own text is the arc length rounded to 6 decimals.
    assert_eq!(format!("{arc:.6}"), "48.653858");
    for length in [
        format!("{arc:.6}"),
        format!("{horizontal:.6}"),
        format!("{arc:.4}"),
    ] {
        let elevation = evaluate_profile(&curve(length.clone()), s1);
        assert!(
            matches!(elevation, Ok(Some(value)) if value.is_finite()),
            "length {length}: {elevation:?}"
        );
    }
    for length in [
        format!("{:.6}", arc + 0.01),
        format!("{:.6}", horizontal - 0.01),
    ] {
        assert_eq!(
            evaluate_profile(&curve(length), s1),
            Err(LandXmlProfileEvaluationError::InconsistentCircularCurve)
        );
    }
}

/// EDGE-LXMATH-10 (#7693). Invariant (parity with `packages/create`'s
/// profile mapping, docs/architecture/landxml-to-ifc-mapping.md §12.4): a
/// signed radius is read by magnitude, negative for a crest; a negative
/// radius on a sag is contradictory and refused.
#[test]
fn edge_lxmath_10_signed_crest_radius_is_read_by_magnitude() {
    // 3D-Win M3 road profile, second curve: a crest written radius="-2000".
    let crest = |radius: &str| {
        profile_document(&format!(
            r#"<PVI>77.651516 16.564087</PVI><CircCurve length="70.618005" radius="{radius}">143.344365 18.366885</CircCurve><PVI>288.117726 17.227053</PVI>"#
        ))
    };
    let negative = evaluate_profile(&crest("-2000.000000"), 143.344365);
    let positive = evaluate_profile(&crest("2000.000000"), 143.344365);
    assert!(matches!(negative, Ok(Some(_))), "{negative:?}");
    assert_eq!(negative, positive);
    let sag = profile_document(
        r#"<PVI>3.780491 16.933442</PVI><CircCurve length="48.653858" radius="-1500">77.651516 16.564087</CircCurve><PVI>143.344365 18.366885</PVI>"#,
    );
    assert_eq!(
        evaluate_profile(&sag, 77.651516),
        Err(LandXmlProfileEvaluationError::InconsistentCircularCurve)
    );
}

/// EDGE-LXMATH-10 (#7693), real model: every circular vertical curve of
/// 3D-Win's M3 road profile (arc lengths, five signed crest radii) evaluates.
#[test]
fn edge_lxmath_10_every_3dwin_circular_curve_evaluates() {
    let Some(xml) = producer_as_landxml_12("landxml/producers/3d-win-6.6.4-m3-road-alignment.xml")
    else {
        return;
    };
    let document = parse_landxml_tin_with_cancel(xml.as_bytes(), &LandXmlLimits::default(), None)
        .expect("3D-Win road document parses");
    let profile = &document.profiles[0];
    let stations: Vec<f64> = profile
        .vertical_curves
        .iter()
        .filter(|curve| curve.kind == LandXmlVerticalCurveKind::Circular)
        .map(|curve| curve.station)
        .collect();
    assert_eq!(stations.len(), 9);
    for station in stations {
        let elevation = profile.evaluate_elevation_at(station);
        assert!(
            matches!(elevation, Ok(Some(value)) if value.is_finite()),
            "CircCurve at {station}: {elevation:?}"
        );
    }
}
