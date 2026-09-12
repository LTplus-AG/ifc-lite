// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Unit tests for `model_bounds.rs`, split out per the house pattern for
//! modules whose bulk is test code so the production module stays inside
//! its module-size ratchet budget.

use super::*;

#[test]
fn test_bounds_creation() {
    let bounds = ModelBounds::new();
    assert!(!bounds.is_valid());
    assert!(!bounds.has_large_coordinates(1.0));
}

#[test]
fn test_bounds_expand() {
    let mut bounds = ModelBounds::new();
    bounds.expand(100.0, 200.0, 50.0);
    bounds.expand(150.0, 250.0, 75.0);

    assert!(bounds.is_valid());
    assert_eq!(bounds.min_x, 100.0);
    assert_eq!(bounds.max_x, 150.0);
    assert_eq!(bounds.min_y, 200.0);
    assert_eq!(bounds.max_y, 250.0);

    let centroid = bounds.centroid();
    assert_eq!(centroid.0, 125.0);
    assert_eq!(centroid.1, 225.0);
}

#[test]
fn test_large_coordinates_detection() {
    let mut bounds = ModelBounds::new();
    // TWO distinct points: with a single sample min == max == centroid, so
    // the assertion below cannot tell the bbox CENTRE from either corner.
    bounds.expand(2679012.0, 1247892.0, 432.0); // Swiss UTM coordinates
    bounds.expand(2679112.0, 1248092.0, 632.0);
    assert!(bounds.has_large_coordinates(1.0));
    // The RTC offset is the bbox centre, not a corner, on ALL THREE axes.
    assert_eq!(bounds.rtc_offset(1.0), (2679062.0, 1247992.0, 532.0));
}

#[test]
fn test_small_coordinates_no_shift() {
    let mut bounds = ModelBounds::new();
    bounds.expand(0.0, 0.0, 0.0);
    bounds.expand(100.0, 100.0, 10.0);

    assert!(!bounds.has_large_coordinates(1.0));

    let offset = bounds.rtc_offset(1.0);
    assert_eq!(offset.0, 0.0);
    assert_eq!(offset.1, 0.0);
    assert_eq!(offset.2, 0.0);
}

#[test]
fn test_extract_point_coordinates_3d() {
    let text = "IFCCARTESIANPOINT((2679012.123,1247892.456,432.789))";
    let coords = extract_point_coordinates(text).unwrap();

    assert!((coords.0 - 2679012.123).abs() < 0.001);
    assert!((coords.1 - 1247892.456).abs() < 0.001);
    assert!((coords.2.unwrap() - 432.789).abs() < 0.001);
}

#[test]
fn test_extract_point_coordinates_2d() {
    let text = "IFCCARTESIANPOINT((100.5,200.5))";
    let coords = extract_point_coordinates(text).unwrap();

    assert_eq!(coords.0, 100.5);
    assert_eq!(coords.1, 200.5);
    assert!(coords.2.is_none());
}

#[test]
fn test_scan_model_bounds() {
    let ifc_content = r#"
ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
ENDSEC;
DATA;
#1=IFCCARTESIANPOINT((2679012.0,1247892.0,432.0));
#2=IFCCARTESIANPOINT((2679112.0,1247992.0,442.0));
#3=IFCWALL('guid',$,$,$,$,$,$,$);
ENDSEC;
END-ISO-10303-21;
"#;

    let bounds = scan_model_bounds(ifc_content);

    assert!(bounds.is_valid());
    assert!(bounds.has_large_coordinates(1.0));
    assert_eq!(bounds.sample_count, 2);

    let centroid = bounds.centroid();
    assert!((centroid.0 - 2679062.0).abs() < 0.001);
    assert!((centroid.1 - 1247942.0).abs() < 0.001);
}

#[test]
fn test_scan_model_bounds_small_model() {
    let ifc_content = r#"
ISO-10303-21;
DATA;
#1=IFCCARTESIANPOINT((0.0,0.0,0.0));
#2=IFCCARTESIANPOINT((10.0,10.0,5.0));
ENDSEC;
END-ISO-10303-21;
"#;

    let bounds = scan_model_bounds(ifc_content);

    assert!(bounds.is_valid());
    assert!(!bounds.has_large_coordinates(1.0));

    let offset = bounds.rtc_offset(1.0);
    assert_eq!(offset.0, 0.0); // No shift needed for small coordinates
}

#[test]
fn test_precision_preserved_with_rtc() {
    // The shift subtracted here is the PRODUCTION offset (`rtc_offset(1.0)` on a
    // real `ModelBounds`), not an inline `(x1 + x2) / 2.0`. The earlier version
    // called no production code at all, so it asserted only a property of
    // IEEE-754 and stayed green even if the whole RTC feature were deleted.
    let x1 = 2679012.123456_f64; // large Swiss UTM coordinates,
    let x2 = 2679012.223456_f64; // 0.1 m apart
    let expected_diff = 0.1;

    let mut bounds = ModelBounds::new();
    bounds.expand(x1, 1247892.0, 432.0);
    bounds.expand(x2, 1247892.5, 432.5);
    assert!(bounds.has_large_coordinates(1.0), "premise: large coords");

    // WITHOUT RTC: cast straight to f32. At ~2.7e6 the f32 ulp is 0.25 m, so
    // this really does destroy the 0.1 m separation. Pinning that keeps the
    // comparison below from passing on two equally-good numbers.
    let diff_direct = ((x2 as f32) - (x1 as f32)) as f64;
    let error_direct = (diff_direct - expected_diff).abs();
    assert!(error_direct > 0.01, "premise: cast must lose 0.1 m");

    // WITH RTC: subtract the offset the pipeline applies (in f64), then cast.
    let (offset_x, _, _) = bounds.rtc_offset(1.0);
    let diff_rtc = (((x2 - offset_x) as f32) - ((x1 - offset_x) as f32)) as f64;
    let error_rtc = (diff_rtc - expected_diff).abs();
    assert!(
        error_rtc < 1.0e-6,
        "RTC-shifted f32 must keep the 0.1 m separation (diff={diff_rtc}, err={error_rtc})"
    );
    assert!(error_rtc < error_direct * 0.1, "RTC must improve precision");
}

/// The 10 km gate is a METRE threshold applied to FILE-unit samples, so it
/// must scale before deciding. A kilometre-unit model 5 000 km from the
/// origin reads `5000 < 10000` on the raw values and skipped the rebase,
/// while the same geometry declared in metres shifted. Scaling the result
/// afterwards (what the caller did) cannot undo a gate that already said no.
#[test]
fn large_coordinate_gate_scales_file_units_to_metres_before_deciding() {
    // Identical raw samples; only the declared unit differs.
    let mut bounds = ModelBounds::new();
    bounds.expand(5000.0, 5000.0, 0.0);
    bounds.expand(5000.1, 5000.1, 0.01);

    // Metres: 5 km out, under the gate.
    assert!(!bounds.has_large_coordinates(1.0));
    assert_eq!(bounds.rtc_offset(1.0), (0.0, 0.0, 0.0));

    // Kilometres: 5 000 km out, must shift, and the offset is in metres.
    assert!(bounds.has_large_coordinates(1000.0));
    let (x, y, z) = bounds.rtc_offset(1000.0);
    assert!((x - 5_000_050.0).abs() < 1e-6, "x offset in metres, got {x}");
    assert!((y - 5_000_050.0).abs() < 1e-6, "y offset in metres, got {y}");
    assert!((z - 5.0).abs() < 1e-6, "z offset in metres, got {z}");
}

/// The mirror image: a millimetre model 25 m wide has raw samples of
/// 25 000, which the unscaled gate read as 25 km and answered with a
/// spurious offset. In metres it is 25 m and no shift is due.
#[test]
fn millimetre_model_inside_ten_metres_is_not_large() {
    let mut bounds = ModelBounds::new();
    bounds.expand(0.0, 0.0, 0.0);
    bounds.expand(25_000.0, 25_000.0, 3_000.0);

    assert!(bounds.has_large_coordinates(1.0), "premise: raw values read as 25 km");
    assert!(!bounds.has_large_coordinates(0.001));
    assert_eq!(bounds.rtc_offset(0.001), (0.0, 0.0, 0.0));
}

/// STEP keyword case is not significant (ISO 10303-21) and the scanner
/// hands the keyword back as written, so a lowercase or CamelCase file
/// must sample the same points as an uppercase one on both scan paths.
#[test]
fn bounds_scans_match_keyword_case_insensitively() {
    let upper = "\
ISO-10303-21;
DATA;
#1=IFCCARTESIANPOINT((2679012.0,1247892.0,432.0));
#2=IFCAXIS2PLACEMENT3D(#1,$,$);
#3=IFCCARTESIANPOINT((1.0,2.0,3.0));
ENDSEC;
END-ISO-10303-21;
";
    let mixed = upper
        .replace("IFCCARTESIANPOINT", "IfcCartesianPoint")
        .replace("IFCAXIS2PLACEMENT3D", "ifcaxis2placement3d");
    assert_ne!(upper, mixed, "premise: the spelling actually changed");

    let (u, m) = (scan_model_bounds(upper), scan_model_bounds(&mixed));
    assert_eq!(u.sample_count, 2, "control: uppercase scan sees both points");
    assert_eq!(m.sample_count, u.sample_count);
    assert_eq!(m.centroid(), u.centroid());

    let (u, m) = (scan_placement_bounds(upper), scan_placement_bounds(&mixed));
    // Only the placement point (#1) qualifies: #3 is neither referenced nor
    // beyond the 1000-unit floor.
    assert_eq!(u.sample_count, 1, "control: uppercase placement scan sees #1 only");
    assert_eq!(m.sample_count, u.sample_count);
    assert_eq!(m.centroid(), u.centroid());
}
