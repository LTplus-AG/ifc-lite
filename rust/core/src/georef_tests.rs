// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Unit tests for `georef.rs`.
//!
//! Split out per the repo convention for modules whose bulk is test code
//! (see `rust/export/src/geom.rs` / `geom_tests.rs`), which also keeps
//! `georef.rs` inside its module-size ratchet budget.

use super::*;

#[test]
fn georef_discovery_does_not_retain_unrelated_property_sets() {
    // Cold-load invariant: searching once for two georeferencing property sets
    // must not retain every other property set in the model's decoder cache.
    let mut source = String::from("DATA;\n");
    let mut types = Vec::new();
    for id in 1..=1000 {
        source.push_str(&format!("#{id}=IFCPROPERTYSET('g',$,'Unrelated',$,(#2001));\n"));
        types.push((id, IfcType::IfcPropertySet));
    }
    source.push_str("#1001=IFCPROPERTYSET('g',$,'ePsEt_MapConversion',$,(#2001));\n#2001=IFCPROPERTYSINGLEVALUE('Eastings',$,IFCLENGTHMEASURE(42.),$);\nENDSEC;");
    types.push((1001, IfcType::IfcPropertySet));
    let mut decoder = EntityDecoder::new(&source);
    let geo = GeoRefExtractor::extract(&mut decoder, &types).unwrap().unwrap();
    assert_eq!(geo.eastings, 42.0);
    assert_eq!(geo.source, GeoRefSource::EPSetMapConversion);
    assert!(decoder.cache_size() <= 2, "only the selected set and its value should be retained");
    assert_eq!(decoder.decode_by_id(500).unwrap().get_string(2), Some("Unrelated"));
}

#[test]
fn test_georef_local_to_map() {
    let mut georef = GeoReference::new();
    georef.eastings = 500000.0;
    georef.northings = 5000000.0;
    georef.orthogonal_height = 100.0;

    let (e, n, h) = georef.local_to_map(10.0, 20.0, 5.0);
    assert!((e - 500010.0).abs() < 1e-10);
    assert!((n - 5000020.0).abs() < 1e-10);
    assert!((h - 105.0).abs() < 1e-10);
}

#[test]
fn test_georef_map_to_local() {
    let mut georef = GeoReference::new();
    georef.eastings = 500000.0;
    georef.northings = 5000000.0;
    georef.orthogonal_height = 100.0;

    let (x, y, z) = georef.map_to_local(500010.0, 5000020.0, 105.0);
    assert!((x - 10.0).abs() < 1e-10);
    assert!((y - 20.0).abs() < 1e-10);
    assert!((z - 5.0).abs() < 1e-10);
}

#[test]
fn test_georef_with_rotation() {
    let mut georef = GeoReference::new();
    georef.eastings = 0.0;
    georef.northings = 0.0;
    // 90 degree rotation
    georef.x_axis_abscissa = 0.0;
    georef.x_axis_ordinate = 1.0;

    let (e, n, _) = georef.local_to_map(10.0, 0.0, 0.0);
    // After 90 degree rotation: (10, 0) -> (0, 10)
    assert!(e.abs() < 1e-10);
    assert!((n - 10.0).abs() < 1e-10);
}

/// `local_to_map`'s rotation must be `e = cos*x - sin*y`, `n = sin*x +
/// cos*y` — a genuine 2D rotation, not `cos*x + sin*y` for both.
///
/// `test_georef_with_rotation` above uses `x_axis_ordinate` (sin) = 1
/// with `y = 0`, and `test_georef_local_to_map` uses `sin = 0` with a
/// nonzero `y` — in both, `cos*x - sin*y` and `cos*x + sin*y` are
/// numerically identical, so a `-` to `+` typo in the `e` term left both
/// green. Only a fixture with a non-axis-aligned rotation AND nonzero x
/// *and* y forces the two terms apart.
#[test]
fn test_georef_local_to_map_rotation_sign_is_a_true_rotation() {
    let mut georef = GeoReference::new();
    georef.eastings = 0.0;
    georef.northings = 0.0;
    // 45 degrees: cos == sin, so only the +/- distinguishes e from n.
    let c = std::f64::consts::FRAC_1_SQRT_2;
    georef.x_axis_abscissa = c;
    georef.x_axis_ordinate = c;

    let (e, n, _) = georef.local_to_map(10.0, 4.0, 0.0);
    assert!((e - c * 6.0).abs() < 1e-10, "e = cos*x - sin*y, got {e}");
    assert!((n - c * 14.0).abs() < 1e-10, "n = sin*x + cos*y, got {n}");
}

#[test]
fn test_georef_map_to_local_with_rotation_round_trips_local_to_map() {
    // `test_georef_with_rotation` above only exercises local_to_map, and
    // only with y=0 -- so it cannot catch a sign error in the sin_r*y
    // term (multiplied by zero either way). `test_georef_map_to_local`
    // only exercises the identity rotation (sin_r=0), so it cannot catch
    // a sign error in map_to_local's sin_r*dx / sin_r*dy terms either.
    // Pin map_to_local under a genuine rotation with BOTH local
    // coordinates nonzero, and cross-check it inverts local_to_map.
    let mut georef = GeoReference::new();
    georef.eastings = 500000.0;
    georef.northings = 4000000.0;
    georef.orthogonal_height = 50.0;
    georef.scale = 2.0;
    let angle = std::f64::consts::FRAC_PI_6; // 30 degrees
    georef.x_axis_abscissa = angle.cos();
    georef.x_axis_ordinate = angle.sin();

    let (lx, ly, lz) = (12.0, -7.0, 3.0);
    let (e, n, h) = georef.local_to_map(lx, ly, lz);
    let (x, y, z) = georef.map_to_local(e, n, h);

    assert!((x - lx).abs() < 1e-9, "map_to_local must invert local_to_map (x), got {x}");
    assert!((y - ly).abs() < 1e-9, "map_to_local must invert local_to_map (y), got {y}");
    assert!((z - lz).abs() < 1e-9, "map_to_local must invert local_to_map (z), got {z}");
}

#[test]
fn test_rtc_offset() {
    let positions = vec![
        500000.0f32,
        5000000.0,
        0.0,
        500010.0,
        5000010.0,
        10.0,
        500020.0,
        5000020.0,
        20.0,
    ];

    let offset = RtcOffset::from_positions(&positions);
    assert!(offset.is_significant());
    assert!((offset.x - 500010.0).abs() < 1.0);
    assert!((offset.y - 5000010.0).abs() < 1.0);
}

#[test]
fn test_rtc_apply() {
    let mut positions = vec![500000.0f32, 5000000.0, 0.0, 500010.0, 5000010.0, 10.0];

    let offset = RtcOffset {
        x: 500000.0,
        y: 5000000.0,
        z: 0.0,
    };

    offset.apply(&mut positions);

    assert!((positions[0] - 0.0).abs() < 1e-5);
    assert!((positions[1] - 0.0).abs() < 1e-5);
    assert!((positions[3] - 10.0).abs() < 1e-5);
    assert!((positions[4] - 10.0).abs() < 1e-5);
}

/// `apply`'s z-channel must subtract `self.z`, not `self.x`/`self.y`.
///
/// `test_rtc_apply` above uses `z: 0.0` and never asserts on
/// `positions[2]`/`positions[5]`, so the third component of `chunk[2] =
/// chunk[2] - self.z` was free to read the wrong field of `self` — a
/// `self.x`-for-`self.z` swap left that test fully green. Distinct,
/// non-zero x/y/z offsets and asserting all three components pins it.
#[test]
fn test_rtc_apply_z_channel_uses_z_offset() {
    let mut positions = vec![100.0f32, 200.0, 300.0];

    let offset = RtcOffset {
        x: 10.0,
        y: 20.0,
        z: 30.0,
    };

    offset.apply(&mut positions);

    assert!((positions[0] - 90.0).abs() < 1e-5);
    assert!((positions[1] - 180.0).abs() < 1e-5);
    assert!((positions[2] - 270.0).abs() < 1e-5);
}

/// The `-0` leniency (#3546 residual): a writer that signs a zero-magnitude
/// degree component of `IfcSite.RefLatitude`/`RefLongitude` (e.g. `(-0, 30,
/// 0)` for 0°30'S) must still land the site in the correct hemisphere.
///
/// Unlike the TS `parseFloat`-based tokenizer (which keeps IEEE-754 `-0`),
/// the Rust STEP tokenizer's `integer()` parses `-0` through
/// `lexical_core::parse::<i64>`, which has no negative-zero representation,
/// so `AttributeValue::Integer` never sees the sign at all —
/// `compound_plane_angle_to_degrees` alone cannot recover it.
/// `extract_from_site` closes the gap by re-scanning the entity's raw
/// record bytes for the literal `-0` token, without touching the shared
/// tokenizer. TS parity: the equivalent fixture in
/// `packages/parser/test/georef-extractor.test.ts`.
#[test]
fn test_extract_from_site_honours_negative_zero_degree_ref3546() {
    let ifc_content = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Test'),'2;1');
FILE_NAME('test.ifc','2024-01-01',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCSITE('1abc',$,'Site',$,$,$,$,$,.ELEMENT.,(-0,30,0),(-0,45,0),0.,$,$);
ENDSEC;
END-ISO-10303-21;
"#;

    let mut decoder = EntityDecoder::new(ifc_content);
    let entity_types = vec![(1u32, IfcType::IfcSite)];

    let georef = GeoRefExtractor::extract(&mut decoder, &entity_types)
        .expect("decode ok")
        .expect("legacy site georeference extracted");

    assert_eq!(georef.source, GeoRefSource::SiteLocation);
    assert!(
        (georef.northings - (-0.5)).abs() < 1e-9,
        "expected northings -0.5 (0°30'S), got {}",
        georef.northings
    );
    assert!(
        (georef.eastings - (-0.75)).abs() < 1e-9,
        "expected eastings -0.75 (0°45'W), got {}",
        georef.eastings
    );
}

/// The leniency applies to every component, matching the TypeScript parser:
/// writers which carry a hemisphere sign on a zero-magnitude minute, second,
/// or millionth-second component must not have that sign discarded by the
/// Rust integer tokenizer.
#[test]
fn test_extract_from_site_honours_negative_zero_in_each_compound_angle_component_ref3546() {
    let cases = [
        // A negative-zero minute signs the following non-zero seconds.
        ("(0,-0,30)", -(30.0 / 3600.0)),
        // A negative-zero second signs the following non-zero millionths.
        ("(0,0,-0,30)", -(30.0 / 1_000_000.0 / 3600.0)),
        // A negative-zero millionth-second signs the preceding non-zero seconds.
        ("(0,0,30,-0)", -(30.0 / 3600.0)),
    ];

    for (angle, expected_northings) in cases {
        let ifc_content = format!(
            "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('Test'),'2;1');\nFILE_NAME('test.ifc','2024-01-01',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n#1=IFCSITE('1abc',$,'Site',$,$,$,$,$,.ELEMENT.,{angle},(14,28,0),0.,$,$);\nENDSEC;\nEND-ISO-10303-21;\n"
        );
        let mut decoder = EntityDecoder::new(&ifc_content);
        let georef = GeoRefExtractor::extract(&mut decoder, &[(1, IfcType::IfcSite)])
            .expect("decode ok")
            .expect("legacy site georeference extracted");

        assert!(
            (georef.northings - expected_northings).abs() < 1e-12,
            "{angle} should produce {expected_northings}, got {}",
            georef.northings
        );
    }
}

/// Control: the spec-canonical encoding (sign on the first NON-ZERO
/// component) must keep working exactly as before — the `-0` leniency must
/// never flip an already-correct sign.
#[test]
fn test_extract_from_site_canonical_negative_degree_unaffected() {
    let ifc_content = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Test'),'2;1');
FILE_NAME('test.ifc','2024-01-01',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCSITE('1abc',$,'Site',$,$,$,$,$,.ELEMENT.,(-50,2,20),(14,28,0),0.,$,$);
ENDSEC;
END-ISO-10303-21;
"#;

    let mut decoder = EntityDecoder::new(ifc_content);
    let entity_types = vec![(1u32, IfcType::IfcSite)];

    let georef = GeoRefExtractor::extract(&mut decoder, &entity_types)
        .expect("decode ok")
        .expect("legacy site georeference extracted");

    let expected_lat = -(50.0 + 2.0 / 60.0 + 20.0 / 3600.0);
    let expected_lon = 14.0 + 28.0 / 60.0;
    assert!((georef.northings - expected_lat).abs() < 1e-9);
    assert!((georef.eastings - expected_lon).abs() < 1e-9);
}

/// Adversarial: a `Name`/`Description` string containing a literal comma or
/// parenthesis must not throw off the raw-byte attribute-index walk that
/// recovers the `-0` sign — the walk must be quote-aware, not just counting
/// top-level commas blindly.
#[test]
fn test_extract_from_site_negative_zero_scan_ignores_commas_inside_quoted_strings() {
    let ifc_content = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('Test'),'2;1');
FILE_NAME('test.ifc','2024-01-01',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCSITE('1abc',$,'Site, (annex)',$,$,$,$,$,.ELEMENT.,(-0,30,0),(-0,45,0),0.,$,$);
ENDSEC;
END-ISO-10303-21;
"#;

    let mut decoder = EntityDecoder::new(ifc_content);
    let entity_types = vec![(1u32, IfcType::IfcSite)];

    let georef = GeoRefExtractor::extract(&mut decoder, &entity_types)
        .expect("decode ok")
        .expect("legacy site georeference extracted");

    assert!((georef.northings - (-0.5)).abs() < 1e-9);
    assert!((georef.eastings - (-0.75)).abs() < 1e-9);
}

fn ifc4x3_with_conversion(map_conversion_line: &str) -> String {
    format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('Test'),'2;1');\nFILE_NAME('t.ifc','2026-01-01',(''),(''),'','','');\nFILE_SCHEMA(('IFC4X3_ADD2'));\nENDSEC;\nDATA;\n#2=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.0E-5,#5,$);\n#4=IFCCARTESIANPOINT((0.,0.,0.));\n#5=IFCAXIS2PLACEMENT3D(#4,$,$);\n#10=IFCPROJECTEDCRS('EPSG:32632',$,$,$,$,$,$);\n{map_conversion_line}\nENDSEC;\nEND-ISO-10303-21;\n"
    )
}

fn extract_map_conversion(map_conversion_line: &str) -> Option<GeoReference> {
    let content = ifc4x3_with_conversion(map_conversion_line);
    let mut decoder = EntityDecoder::new(&content);
    // Both the plain and the Scaled spelling are classified as
    // `IfcMapConversion` by the processing-crate candidate scan; the decoder
    // reads the record's own attribute count either way.
    let types = vec![(11u32, IfcType::IfcMapConversion), (10, IfcType::IfcProjectedCRS)];
    GeoRefExtractor::extract(&mut decoder, &types).expect("decode ok")
}

/// `IfcMapConversionScaled.FactorX/Y/Z` (attributes 8..10) are the only
/// reason the subtype exists and nothing read them: a feet-authored scaled
/// conversion (factors 0.3048, Scale absent) shipped a transform with
/// diagonal [1, 1, 1]. The existing scaled test uses factors of 1.0 and so
/// cannot tell "applied" from "ignored"; this one cannot pass either way.
#[test]
fn scaled_map_conversion_factors_scale_each_axis() {
    let geo = extract_map_conversion(
        "#11=IFCMAPCONVERSIONSCALED(#2,#10,1000.,2000.,42.,1.,0.,$,0.3048,0.3048,0.3048);",
    )
    .expect("scaled conversion is a georeference");

    assert_eq!((geo.factor_x, geo.factor_y, geo.factor_z), (0.3048, 0.3048, 0.3048));
    assert_eq!(geo.scale, 1.0, "the inherited uniform Scale stays at its default");

    let (e, n, h) = geo.local_to_map(10.0, 20.0, 5.0);
    assert!((e - 1003.048).abs() < 1e-9, "e = {e}");
    assert!((n - 2006.096).abs() < 1e-9, "n = {n}");
    assert!((h - 43.524).abs() < 1e-9, "h = {h}");

    let m = geo.to_matrix();
    assert!((m[0] - 0.3048).abs() < 1e-12 && (m[5] - 0.3048).abs() < 1e-12 && (m[10] - 0.3048).abs() < 1e-12,
        "matrix diagonal must carry the factors, got [{}, {}, {}]", m[0], m[5], m[10]);

    // Round trip through the inverse, per axis.
    let (x, y, z) = geo.map_to_local(e, n, h);
    assert!((x - 10.0).abs() < 1e-9 && (y - 20.0).abs() < 1e-9 && (z - 5.0).abs() < 1e-9);
}

/// Anisotropic factors under rotation: the factor is applied on the LOCAL
/// axis before the rotation, so with factor_x != factor_y the rotated
/// result differs from "rotate then scale". Pins the order.
#[test]
fn scaled_map_conversion_applies_factors_before_rotation() {
    // 90 degrees: local x maps onto map north.
    let geo = extract_map_conversion(
        "#11=IFCMAPCONVERSIONSCALED(#2,#10,0.,0.,0.,0.,1.,2.,3.,5.,7.);",
    )
    .expect("georeference");
    let (e, n, h) = geo.local_to_map(1.0, 1.0, 1.0);
    // x: 1 * 2 * 3 = 6 lands on north; y: 1 * 2 * 5 = 10 lands on -east.
    assert!((e + 10.0).abs() < 1e-9, "e = {e}");
    assert!((n - 6.0).abs() < 1e-9, "n = {n}");
    assert!((h - 14.0).abs() < 1e-9, "h = {h}");
    let (x, y, z) = geo.map_to_local(e, n, h);
    assert!((x - 1.0).abs() < 1e-9 && (y - 1.0).abs() < 1e-9 && (z - 1.0).abs() < 1e-9);
}

/// A plain `IfcMapConversion` (eight attributes) leaves every factor at 1.0
/// and keeps the uniform-scale behaviour byte-for-byte.
#[test]
fn plain_map_conversion_keeps_unit_factors() {
    let geo = extract_map_conversion("#11=IFCMAPCONVERSION(#2,#10,1000.,2000.,42.,1.,0.,2.);")
        .expect("georeference");
    assert_eq!((geo.factor_x, geo.factor_y, geo.factor_z), (1.0, 1.0, 1.0));
    assert_eq!(geo.scale, 2.0);
    assert_eq!(geo.local_to_map(10.0, 20.0, 5.0), (1020.0, 2040.0, 52.0));
}

/// A zero-length X-axis direction (`XAxisAbscissa = XAxisOrdinate = 0.`) must
/// reset to the identity direction, not pass through: used as cos/sin it
/// collapsed every local point to `(Eastings, Northings)`.
#[test]
fn zero_length_axis_direction_resets_to_identity() {
    let geo = extract_map_conversion("#11=IFCMAPCONVERSION(#2,#10,1000.,2000.,42.,0.,0.,1.);")
        .expect("georeference");
    assert_eq!((geo.x_axis_abscissa, geo.x_axis_ordinate), (1.0, 0.0));
    assert_eq!(geo.local_to_map(10.0, 20.0, 5.0), (1010.0, 2020.0, 47.0));
    // Two distinct local points must map to two distinct map points.
    assert_ne!(geo.local_to_map(1.0, 0.0, 0.0), geo.local_to_map(2.0, 0.0, 0.0));
}

/// A rotation-only conversion (zero offsets, 30 degrees to grid north, no
/// `IfcProjectedCRS`) is a georeference: the TS twin reports one whenever a
/// map conversion parsed, and the value-based test dropped it.
#[test]
fn rotation_only_map_conversion_is_reported() {
    let content = ifc4x3_with_conversion(
        "#11=IFCMAPCONVERSION(#2,#12,0.,0.,0.,0.8660254037844387,0.5,1.);\n#12=IFCGEOGRAPHICCRS('EPSG:4326',$,$,$,$,$,$);",
    );
    let mut decoder = EntityDecoder::new(&content);
    // No IfcProjectedCRS candidate: the CRS name stays None.
    let geo = GeoRefExtractor::extract(&mut decoder, &[(11u32, IfcType::IfcMapConversion)])
        .expect("decode ok")
        .expect("a parsed map conversion is a georeference even with zero offsets");
    assert!(geo.has_map_conversion);
    assert_eq!(geo.crs_name, None);
    assert!((geo.rotation().to_degrees() - 30.0).abs() < 1e-9);
}

/// Buffers of length 1 or 2 hold no complete position: the offset must be
/// zero, not `0.0 / 0` = NaN, which `apply` would then write into every
/// vertex.
#[test]
fn rtc_from_positions_with_no_whole_triple_is_zero_not_nan() {
    for buffer in [&[1.0f32][..], &[1.0f32, 2.0][..]] {
        let offset = RtcOffset::from_positions(buffer);
        assert_eq!((offset.x, offset.y, offset.z), (0.0, 0.0, 0.0), "len {}", buffer.len());
    }
    // A trailing partial triple is ignored, not averaged in.
    let offset = RtcOffset::from_positions(&[1.0, 2.0, 3.0, 99.0]);
    assert_eq!((offset.x, offset.y, offset.z), (1.0, 2.0, 3.0));
}

/// A non-numeric component in a compound plane angle refuses the WHOLE
/// angle. Compacting the list first re-indexed `($,51,30,0)` as 51 deg 30
/// min and placed the site instead of skipping it.
#[test]
fn compound_plane_angle_with_non_numeric_component_is_refused() {
    let angles = ["($,51,30,0)", "(51,$,30,0)", "(51,30,$,0)", "(51,30,0,$)"];
    for angle in angles {
        let content = format!(
            "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('Test'),'2;1');\nFILE_NAME('t.ifc','2026-01-01',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n#1=IFCSITE('1abc',$,'Site',$,$,$,$,$,.ELEMENT.,{angle},(14,28,0),0.,$,$);\nENDSEC;\nEND-ISO-10303-21;\n"
        );
        let mut decoder = EntityDecoder::new(&content);
        let geo = GeoRefExtractor::extract(&mut decoder, &[(1, IfcType::IfcSite)]).expect("decode ok");
        assert!(geo.is_none(), "{angle} must be refused, got {:?}", geo.map(|g| g.northings));
    }

    // Control: the numeric four-component form still resolves by position.
    let content = "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('Test'),'2;1');\nFILE_NAME('t.ifc','2026-01-01',(''),(''),'','','');\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n#1=IFCSITE('1abc',$,'Site',$,$,$,$,$,.ELEMENT.,(51,30,0,500000),(14,28,0),0.,$,$);\nENDSEC;\nEND-ISO-10303-21;\n";
    let mut decoder = EntityDecoder::new(content);
    let geo = GeoRefExtractor::extract(&mut decoder, &[(1, IfcType::IfcSite)])
        .expect("decode ok")
        .expect("numeric angle resolves");
    let expected = 51.0 + 30.0 / 60.0 + 0.5 / 3600.0;
    assert!((geo.northings - expected).abs() < 1e-12, "got {}", geo.northings);
}
