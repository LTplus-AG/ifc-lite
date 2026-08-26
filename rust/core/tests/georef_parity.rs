// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Pins `ifc_lite_core::GeoRefExtractor` to the shared cross-language
//! georeferencing vectors in `tests/fixtures/georef_vectors.json`. The
//! TypeScript twin (`packages/parser/src/georef-extractor.ts`, exercised by
//! `packages/parser/src/georef.parity.test.ts`) is held to the SAME fixture,
//! so the two extractors cannot drift apart unnoticed.
//!
//! Georeferencing is thirteen function pairs implemented twice. Before this
//! harness nothing but a doc comment asserted the halves agreed, and each
//! side's own suite could stay green while the two disagreed by a factor of
//! a thousand on a real file.
//!
//! The expectations are anchored to the EXPRESS schema and to IFC semantics,
//! never to either implementation's current output — a diff of the two halves
//! against each other goes green on behaviour that is wrong the same way on
//! both sides.

use ifc_lite_core::{EntityDecoder, EntityScanner, GeoRefExtractor, GeoReference, IfcType};

/// Scan the fixture into the `(id, IfcType)` pairs `GeoRefExtractor::extract`
/// consumes, the way the real pipeline does.
fn scan_entity_types(ifc: &str) -> Vec<(u32, IfcType)> {
    let mut scanner = EntityScanner::new(ifc);
    let mut out = Vec::new();
    while let Some((id, type_name, _start, _end)) = scanner.next_entity() {
        out.push((id, IfcType::from_str(type_name)));
    }
    out
}

fn approx(name: &str, field: &str, got: f64, want: f64) {
    // Relative tolerance on the magnitude of the expectation, with an absolute
    // floor so an expected 0.0 is still comparable. Every expectation is an
    // exact decimal or a transcendental constant reproduced identically in
    // both languages, so 1e-9 relative is far looser than the real agreement
    // and still catches any semantic divergence (the smallest one this file
    // guards is a factor of 10).
    let tol = want.abs() * 1e-9 + 1e-9;
    assert!(
        (got - want).abs() <= tol,
        "case `{name}`: {field}: got {got}, want {want}"
    );
}

fn opt_str<'a>(v: &'a serde_json::Value, key: &str) -> Option<Option<&'a str>> {
    let field = v.get(key)?;
    if field.is_null() {
        return Some(None);
    }
    Some(Some(field.as_str().expect("string or null")))
}

fn check_case(name: &str, expect: &serde_json::Value, georef: Option<&GeoReference>) {
    let want_has = expect["hasGeoreference"].as_bool().expect("hasGeoreference");
    if !want_has {
        assert!(
            georef.is_none(),
            "case `{name}`: expected no georeference, got {georef:?}"
        );
        return;
    }
    let g = georef.unwrap_or_else(|| {
        panic!("case `{name}`: expected a georeference, extractor returned None")
    });

    if let Some(want) = expect.get("source").and_then(|s| s.as_str()) {
        assert_eq!(g.source.label(), want, "case `{name}`: source");
    }
    for (key, got) in [
        ("crsName", &g.crs_name),
        ("crsDescription", &g.crs_description),
        ("geodeticDatum", &g.geodetic_datum),
        ("verticalDatum", &g.vertical_datum),
        ("mapProjection", &g.map_projection),
        ("mapZone", &g.map_zone),
        ("mapUnit", &g.map_unit),
    ] {
        if let Some(want) = opt_str(expect, key) {
            assert_eq!(
                got.as_deref(),
                want,
                "case `{name}`: {key}: got {got:?}, want {want:?}"
            );
        }
    }

    if let Some(field) = expect.get("mapUnitScale") {
        if field.is_null() {
            assert!(
                g.map_unit_scale.is_none(),
                "case `{name}`: mapUnitScale: got {:?}, want null (no MapUnit authored: \
                 the project length unit applies and the reader must not invent one)",
                g.map_unit_scale
            );
        } else {
            let want = field.as_f64().expect("mapUnitScale is a number");
            let got = g
                .map_unit_scale
                .unwrap_or_else(|| panic!("case `{name}`: mapUnitScale: got null, want {want}"));
            approx(name, "mapUnitScale", got, want);
        }
    }

    for (key, got) in [
        ("eastings", g.eastings),
        ("northings", g.northings),
        ("orthogonalHeight", g.orthogonal_height),
        ("xAxisAbscissa", g.x_axis_abscissa),
        ("xAxisOrdinate", g.x_axis_ordinate),
        ("scale", g.scale),
    ] {
        if let Some(want) = expect.get(key).and_then(|v| v.as_f64()) {
            approx(name, key, got, want);
        }
    }

    // Behavioural check: the transform itself, not just the parsed fields.
    if let Some(points) = expect.get("localToMap").and_then(|v| v.as_array()) {
        for point in points {
            let l: Vec<f64> = point["local"]
                .as_array()
                .expect("local is an array")
                .iter()
                .map(|v| v.as_f64().expect("number"))
                .collect();
            let want: Vec<f64> = point["map"]
                .as_array()
                .expect("map is an array")
                .iter()
                .map(|v| v.as_f64().expect("number"))
                .collect();

            let (e, n, h) = g.local_to_map(l[0], l[1], l[2]);
            approx(name, "local_to_map.e", e, want[0]);
            approx(name, "local_to_map.n", n, want[1]);
            approx(name, "local_to_map.h", h, want[2]);

            // to_matrix() must agree with local_to_map on the same point:
            // two ways to express one transform, both shipped to consumers.
            let m = g.to_matrix();
            approx(name, "to_matrix.e", m[0] * l[0] + m[4] * l[1] + m[8] * l[2] + m[12], want[0]);
            approx(name, "to_matrix.n", m[1] * l[0] + m[5] * l[1] + m[9] * l[2] + m[13], want[1]);
            approx(name, "to_matrix.h", m[2] * l[0] + m[6] * l[1] + m[10] * l[2] + m[14], want[2]);

            // map_to_local is the documented inverse: round-tripping the map
            // point must land back on the local point.
            let (rx, ry, rz) = g.map_to_local(want[0], want[1], want[2]);
            approx(name, "map_to_local.x", rx, l[0]);
            approx(name, "map_to_local.y", ry, l[1]);
            approx(name, "map_to_local.z", rz, l[2]);
        }
    }
}

fn fixture() -> serde_json::Value {
    let raw = include_str!("fixtures/georef_vectors.json");
    serde_json::from_str(raw).expect("fixture is valid JSON")
}

#[test]
fn rust_georef_matches_shared_vectors() {
    let doc = fixture();
    let cases = doc["cases"].as_array().expect("cases is an array");

    for case in cases {
        let name = case["name"].as_str().expect("name is a string");
        let ifc = case["ifc"].as_str().expect("ifc is a string");

        let entity_types = scan_entity_types(ifc);
        let mut decoder = EntityDecoder::new(ifc);
        let georef = GeoRefExtractor::extract(&mut decoder, &entity_types)
            .unwrap_or_else(|e| panic!("case `{name}`: extraction failed: {e:?}"));

        check_case(name, &case["expect"], georef.as_ref());
    }
}

/// Anti-vacuity guard. A count floor is not enough: dropping the exact case a
/// defect was about keeps a floor satisfied. Every name in `requiredCases`
/// must be present AND must have been exercised above, so deleting an
/// inconvenient vector fails the suite instead of quietly shrinking it.
#[test]
fn fixture_carries_every_required_case() {
    let doc = fixture();
    let required = doc["requiredCases"]
        .as_array()
        .expect("requiredCases is an array");
    assert!(
        !required.is_empty(),
        "requiredCases must name the vectors that may not be dropped"
    );

    let present: Vec<&str> = doc["cases"]
        .as_array()
        .expect("cases is an array")
        .iter()
        .map(|c| c["name"].as_str().expect("name is a string"))
        .collect();

    for want in required {
        let want = want.as_str().expect("requiredCases entries are strings");
        assert!(
            present.contains(&want),
            "required vector `{want}` is missing from the shared fixture"
        );
    }

    // The IfcSIPrefix members the georeferencing readers must resolve. These
    // are EXPRESS enumeration members, not a preference: a MapUnit carrying
    // any of them and read as plain METRE is wrong by that prefix's factor.
    for prefix in [
        "MILLI", "CENTI", "DECI", "DECA", "HECTO", "KILO", "MICRO", "NANO", "MEGA", "GIGA",
    ] {
        let want = format!("projected_crs_si_prefix_{prefix}");
        assert!(
            present.contains(&want.as_str()),
            "IfcSIPrefix.{prefix} has no vector: `{want}` is missing"
        );
    }

    // The ePSet free-text label path is where BOTH halves were wrong the same
    // way, so a harness that only diffs the two could not see it. These are
    // the labels a `contains("METRE")` test silently collapses onto 1.0, plus
    // the two refusal cases that prove the reader declines instead of
    // approximating. Named individually: dropping any one of them is exactly
    // how this defect would come back.
    for want in [
        "epset_map_unit_label_DECAMETRE",
        "epset_map_unit_label_HECTOMETRE",
        "epset_map_unit_label_KILOMETRE",
        "epset_map_unit_label_MICROMETRE",
        "epset_map_unit_label_SQUARE_METRE_REFUSED",
        "epset_map_unit_label_UNKNOWN_REFUSED",
        // MapUnit is exporter FREE TEXT, so the plural, the US spelling and
        // the separated US-survey word orders are ordinary real values.
        // Refusing a recognisable spelling is its own defect: it silently
        // hands the model back to the project length unit.
        "epset_map_unit_label_METRES_PLURAL",
        "epset_map_unit_label_MILLIMETRES_PLURAL",
        "epset_map_unit_label_DECAMETRES_PLURAL",
        "epset_map_unit_label_INCHES_PLURAL",
        "epset_map_unit_label_metres_lowercase",
        "epset_map_unit_label_US_SURVEY_FOOT_PARENTHESISED",
        "epset_map_unit_label_US_SURVEY_FEET_WORD_ORDER",
        // ...and the controls proving the normalisation did not become a
        // sniffer: an area unit and an unqualified survey foot still decline.
        "epset_map_unit_label_SQUARE_METRES_REFUSED",
        "epset_map_unit_label_SURVEY_FOOT_NO_NATION_REFUSED",
    ] {
        assert!(
            present.contains(&want),
            "ePSet MapUnit label vector `{want}` is missing from the shared fixture"
        );
    }
}
