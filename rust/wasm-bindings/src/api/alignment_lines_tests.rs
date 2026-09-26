// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Alignment line regressions included from `api::mod_tests` so they still run
//! when the changed-test oracle reverts `alignment_lines.rs`.

use super::super::alignment_lines::extract_alignment_line_vertices;
use ifc_lite_core::EntityScanner;
use ifc_lite_processing::MeshFrame;

// Minimal IFC4X1 alignment: IfcAlignment whose Axis (attr 7) is a
// 3-point IfcPolyline directrix (0,0,0)->(10,0,0)->(10,10,0), metres.
const CONTENT: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('','',(''),(''),'','','');
FILE_SCHEMA(('IFC4X1'));
ENDSEC;
DATA;
#1=IFCCARTESIANPOINT((0.,0.,0.));
#2=IFCCARTESIANPOINT((10.,0.,0.));
#3=IFCCARTESIANPOINT((10.,10.,0.));
#4=IFCPOLYLINE((#1,#2,#3));
#10=IFCALIGNMENT('0aBcDeFgHiJkLmNoPqRsT0',$,'Test Alignment',$,$,$,$,#4,$);
ENDSEC;
END-ISO-10303-21;
"#;

#[test]
fn emits_line_list_for_polyline_alignment() {
    let verts = extract_alignment_line_vertices(CONTENT, None);
    assert!(!verts.is_empty(), "alignment must emit centerline vertices");
    // Flat [x,y,z] triples, even count of vertices (line-list pairs).
    assert_eq!(verts.len() % 3, 0, "vertices must be xyz triples");
    assert_eq!((verts.len() / 3) % 2, 0, "line-list = even vertex count");

    // First sample is the directrix start (0,0,0) → renderer (0,0,-0).
    assert!(verts[0].abs() < 1e-4, "start x≈0, got {}", verts[0]);
    assert!(verts[1].abs() < 1e-4, "start y(elev)≈0, got {}", verts[1]);
    assert!(verts[2].abs() < 1e-4, "start z≈0, got {}", verts[2]);

    // The 20 m polyline lies in the plan (z_ifc = 0) so every renderer-Y
    // (elevation) must stay 0, and the path must span ~10 m in renderer X
    // and ~10 m in renderer Z (plan Y, negated).
    let mut max_x = f32::MIN;
    let mut max_abs_z = 0.0_f32;
    for v in verts.chunks_exact(3) {
        assert!(v[1].abs() < 1e-3, "planar alignment elevation must be ~0");
        max_x = max_x.max(v[0]);
        max_abs_z = max_abs_z.max(v[2].abs());
    }
    assert!((max_x - 10.0).abs() < 0.5, "max renderer-x ≈10, got {max_x}");
    assert!((max_abs_z - 10.0).abs() < 0.5, "max |renderer-z| ≈10, got {max_abs_z}");
}

// IFC4x3: the directrix lives in Representation 'Axis' as an
// IfcGradientCurve (quarter arc R = 100 on a +1 % grade from 50 m) and
// the alignment is placed at (1000, 0, 0).
const CONTENT_4X3: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('','',(''),(''),'','','');
FILE_SCHEMA(('IFC4X3_ADD2'));
ENDSEC;
DATA;
#20=IFCCARTESIANPOINT((0.,0.));
#21=IFCDIRECTION((1.,0.));
#22=IFCAXIS2PLACEMENT2D(#20,#21);
#23=IFCVECTOR(#21,1.);
#24=IFCLINE(#20,#23);
#25=IFCCIRCLE(#22,100.);
#26=IFCCURVESEGMENT(.CONTINUOUS.,#22,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(157.0796326795),#25);
#27=IFCCARTESIANPOINT((100.,100.));
#28=IFCDIRECTION((0.,1.));
#29=IFCAXIS2PLACEMENT2D(#27,#28);
#30=IFCCURVESEGMENT(.DISCONTINUOUS.,#29,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(0.),#24);
#31=IFCCOMPOSITECURVE((#26,#30),.F.);
#32=IFCCARTESIANPOINT((0.,50.));
#33=IFCDIRECTION((1.,0.01));
#34=IFCAXIS2PLACEMENT2D(#32,#33);
#35=IFCCURVESEGMENT(.CONTINUOUS.,#34,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(157.08),#24);
#36=IFCCARTESIANPOINT((157.0796326795,51.570796326795));
#37=IFCAXIS2PLACEMENT2D(#36,#33);
#38=IFCCURVESEGMENT(.DISCONTINUOUS.,#37,IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(0.),#24);
#39=IFCGRADIENTCURVE((#35,#38),.F.,#31,$);
#40=IFCSHAPEREPRESENTATION($,'Axis','Curve3D',(#39));
#41=IFCSHAPEREPRESENTATION($,'FootPrint','Curve2D',(#31));
#42=IFCPRODUCTDEFINITIONSHAPE($,$,(#41,#40));
#43=IFCCARTESIANPOINT((1000.,0.,0.));
#44=IFCAXIS2PLACEMENT3D(#43,$,$);
#45=IFCLOCALPLACEMENT($,#44);
#46=IFCALIGNMENT('1aBcDeFgHiJkLmNoPqRsT0',$,'Road',$,$,#45,#42,$);
ENDSEC;
END-ISO-10303-21;
"#;

#[test]
fn ifc4x3_axis_representation_follows_arc_grade_and_placement() {
    let verts = extract_alignment_line_vertices(
        CONTENT_4X3,
        Some(MeshFrame::ModelRtc { anchor: (0.0, 0.0, 0.0) }),
    );
    assert!(!verts.is_empty(), "IFC4x3 alignment must emit a centerline");
    let (mut min_x, mut max_x, mut min_e, mut max_e) = (f32::MAX, f32::MIN, f32::MAX, f32::MIN);
    for v in verts.chunks_exact(3) {
        min_x = min_x.min(v[0]);
        max_x = max_x.max(v[0]);
        min_e = min_e.min(v[1]);
        max_e = max_e.max(v[1]);
    }
    // Placement shifts x by 1000; the arc spans 100 m in x.
    assert!((min_x - 1000.0).abs() < 0.1, "min x {min_x}");
    assert!((max_x - 1100.0).abs() < 0.1, "max x {max_x}");
    // Elevation (renderer Y) comes from the gradient: 50 → 51.57 m.
    assert!((min_e - 50.0).abs() < 0.01, "start elevation {min_e}");
    assert!((max_e - 51.5708).abs() < 0.01, "end elevation {max_e}");
}

/// #5327: horizontal sampling starts at local station zero even when the
/// gradient's authored chainage starts at 1000 m.
#[test]
fn ifc4x3_gradient_rebases_nonzero_start_station() {
    let content = CONTENT_4X3
        .replace("(0.,50.)", "(1000.,50.)")
        .replace("(157.0796326795,51.570796326795)", "(1157.0796326795,51.570796326795)");
    let verts = extract_alignment_line_vertices(
        &content,
        Some(MeshFrame::ModelRtc { anchor: (0.0, 0.0, 0.0) }),
    );
    assert!(!verts.is_empty(), "IFC4x3 alignment must emit a centerline");
    let elevations: Vec<_> = verts.chunks_exact(3).map(|v| v[1]).collect();
    assert!((elevations[0] - 50.0).abs() < 0.01, "start elevation {}", elevations[0]);
    assert!((elevations[elevations.len() - 1] - 51.5708).abs() < 0.01,
        "end elevation {}", elevations[elevations.len() - 1]);
}

#[test]
fn explicit_model_rtc_overrides_standalone_alignment_detection() {
    let verts = extract_alignment_line_vertices(
        CONTENT,
        Some(MeshFrame::ModelRtc {
            anchor: (5.0, 0.0, 0.0),
        }),
    );
    assert!((verts[0] + 5.0).abs() < 1e-4);
}

// ═══════════════════════════════════════════════════════════════════════
// Render-frame conversion
// ═══════════════════════════════════════════════════════════════════════
//
// `CONTENT` above is a metre file (unit_scale exactly 1) with no
// IfcProject at all, sits at the origin (RTC exactly 0), and its
// assertions take `.abs()` of the renderer Z. Between them, three
// independent halves of `append_alignment_segments` are unobservable:
// dropping the `unit_scale` multiply, adding the RTC offset instead of
// subtracting it, and dropping the negation on the renderer Z all pass
// that test unchanged. These two pin each one on its own.

/// Millimetre file (`IfcSIUnit` with the `.MILLI.` prefix): every file
/// coordinate is 1000x its metre value, so a dropped `unit_scale` puts the
/// centerline kilometres away. The directrix runs to `(10000, 4000)` mm =
/// `(10, 4)` m, whose renderer Z is `-4` — SIGNED, so the negation cannot
/// hide behind an absolute value either.
const MILLIMETRE_ALIGNMENT: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('','',(''),(''),'','','');
FILE_SCHEMA(('IFC4X1'));
ENDSEC;
DATA;
#6=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#7=IFCUNITASSIGNMENT((#6));
#8=IFCPROJECT('0PrOjEcTpRoJeCtPrOjEc',$,'P',$,$,$,$,$,#7);
#1=IFCCARTESIANPOINT((0.,0.,0.));
#2=IFCCARTESIANPOINT((10000.,4000.,0.));
#4=IFCPOLYLINE((#1,#2));
#10=IFCALIGNMENT('0aBcDeFgHiJkLmNoPqRsT0',$,'Test Alignment',$,$,$,$,#4,$);
ENDSEC;
END-ISO-10303-21;
"#;

#[test]
fn millimetre_alignment_is_unit_scaled_and_yup_swapped() {
    let verts = extract_alignment_line_vertices(MILLIMETRE_ALIGNMENT, None);
    assert!(!verts.is_empty(), "alignment must emit centerline vertices");
    assert_eq!(verts.len() % 3, 0, "vertices must be xyz triples");

    let mut max_x = f32::MIN;
    let mut min_z = f32::MAX;
    let mut max_z = f32::MIN;
    for v in verts.chunks_exact(3) {
        assert!(v[1].abs() < 1e-2, "planar alignment elevation must be ~0, got {}", v[1]);
        max_x = max_x.max(v[0]);
        min_z = min_z.min(v[2]);
        max_z = max_z.max(v[2]);
    }
    // 10 000 mm -> 10 m. Unscaled it would read 10 000.
    assert!((max_x - 10.0).abs() < 0.05, "max renderer-x = 10 m, got {max_x}");
    // 4 000 mm -> 4 m, NEGATED on the way into the renderer frame: the
    // whole path lies at z <= 0, so a dropped negation flips the interval.
    assert!((min_z + 4.0).abs() < 0.05, "min renderer-z = -4 m, got {min_z}");
    assert!(max_z <= 1e-2, "renderer-z must never go positive, got {max_z}");
}

/// A georeferenced metre file: a wall out at survey coordinates trips RTC
/// detection, and the alignment shares that frame. The offset is
/// SUBTRACTED, so the centerline lands near the origin; adding it instead
/// (or subtracting the wrong component) puts it ~2x the offset out, i.e.
/// megametres away, which no near-origin bound can miss.
#[test]
fn georeferenced_alignment_is_rebased_near_the_origin() {
    let content = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('','',(''),(''),'','','');
FILE_SCHEMA(('IFC4X1'));
ENDSEC;
DATA;
#2=IFCDIRECTION((0.,0.,1.));
#3=IFCDIRECTION((1.,0.,0.));
/* a wall far out at survey coords so RTC detection trips (>10 km) */
#6=IFCCARTESIANPOINT((10400000.,2000000.,0.));
#7=IFCAXIS2PLACEMENT3D(#6,#2,#3);
#8=IFCLOCALPLACEMENT($,#7);
#9=IFCPRODUCTDEFINITIONSHAPE($,$,(#41));
#40=IFCCARTESIANPOINT((10400000.,2000000.,0.));
#41=IFCSHAPEREPRESENTATION($,'Body','Curve2D',(#42));
#42=IFCPOLYLINE((#40,#40));
#43=IFCWALL('1WaLLWaLLWaLLWaLLWaLL00',$,'W',$,$,#8,#9,$,$);
/* the alignment directrix in the same survey frame */
#50=IFCCARTESIANPOINT((10400000.,2000000.,0.));
#51=IFCCARTESIANPOINT((10400010.,2000004.,0.));
#52=IFCPOLYLINE((#50,#51));
#10=IFCALIGNMENT('0aBcDeFgHiJkLmNoPqRsT0',$,'A',$,$,$,$,#52,$);
ENDSEC;
END-ISO-10303-21;
"#;
    let verts = extract_alignment_line_vertices(content, None);
    assert!(!verts.is_empty(), "alignment must emit centerline vertices");
    for v in verts.chunks_exact(3) {
        for c in v {
            assert!(
                c.abs() < 1000.0,
                "render-frame coord must be near origin after RTC, got {c}"
            );
        }
    }


    let raw = extract_alignment_line_vertices(content, Some(MeshFrame::RawIfc));
    assert!(
        raw[0] > 1_000_000.0,
        "an explicit known-false frame must not fall back to standalone RTC detection",
    );
}

/// `locate_axis_curve` tries attributes 7, 8, then 6 — `Axis` first, with
/// `Representation` (6) only as a last-resort fallback for publishers that
/// reuse it. Every other fixture here leaves 6 null, so the ORDER of that
/// list is unobservable: searching 6 first passes them all. Here both
/// resolve to a polyline and only `Axis` gives the right geometry.
#[test]
fn axis_attribute_wins_over_the_representation_fallback() {
    let content = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('','',(''),(''),'','','');
FILE_SCHEMA(('IFC4X1'));
ENDSEC;
DATA;
/* Axis (attr 7): runs 10 m along +X. */
#1=IFCCARTESIANPOINT((0.,0.,0.));
#2=IFCCARTESIANPOINT((10.,0.,0.));
#4=IFCPOLYLINE((#1,#2));
/* Representation (attr 6): a decoy running 500 m along +X. */
#5=IFCCARTESIANPOINT((500.,0.,0.));
#6=IFCPOLYLINE((#1,#5));
#7=IFCSHAPEREPRESENTATION($,'Axis','Curve3D',(#6));
#8=IFCPRODUCTDEFINITIONSHAPE($,$,(#7));
#10=IFCALIGNMENT('0aBcDeFgHiJkLmNoPqRsT0',$,'A',$,$,$,#8,#4,$);
ENDSEC;
END-ISO-10303-21;
"#;
    let verts = extract_alignment_line_vertices(content, None);
    assert!(!verts.is_empty(), "alignment must emit centerline vertices");
    let max_x = verts
        .chunks_exact(3)
        .map(|v| v[0])
        .fold(f32::MIN, f32::max);
    assert!(
        (max_x - 10.0).abs() < 0.5,
        "the Axis curve (10 m) must win over the Representation decoy (500 m), got {max_x}"
    );
}

#[test]
fn empty_for_no_alignment() {
    let none = "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n";
    assert!(extract_alignment_line_vertices(none, None).is_empty());
}

/// #5327: the buildingSMART Viadotto Acerno has three placed IFC4x3
/// alignments. Check the actual line-list output in the raw IFC frame so a
/// lost placement, vertical profile, or whole alignment changes its bounds.
#[test]
fn viadotto_acerno_emits_three_placed_centerlines() {
    const FIXTURE: &str = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tests/models/buildingsmart/Viadotto_Acerno.ifc"
    );
    let require_fixtures = match std::env::var("IFC_LITE_REQUIRE_FIXTURES").as_deref() {
        Err(std::env::VarError::NotPresent) | Ok("") | Ok("0") => false,
        Ok("1") => true,
        other => panic!("invalid IFC_LITE_REQUIRE_FIXTURES value: {other:?}"),
    };
    let content = match std::fs::read_to_string(FIXTURE) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if require_fixtures {
                panic!("fixture missing at {FIXTURE}; run `pnpm fixtures`");
            }
            eprintln!("skipping #5327: fixture missing at {FIXTURE}; run `pnpm fixtures`");
            return;
        }
        Err(error) => panic!("failed to read fixture {FIXTURE}: {error}"),
    };

    let mut scanner = EntityScanner::new(&content);
    let mut alignment_count = 0;
    while let Some((_, name, _, _)) = scanner.next_entity() {
        if ifc_lite_core::keyword_eq(name, "IFCALIGNMENT") {
            alignment_count += 1;
        }
    }
    assert_eq!(alignment_count, 3, "fixture must contain three IfcAlignment entities");

    // An explicit raw frame preserves the authored placement coordinates.
    // Within a centerline adjacent line-list segments share their endpoint;
    // a discontinuity starts the next alignment's output.
    let vertices = extract_alignment_line_vertices(&content, Some(MeshFrame::RawIfc));
    assert_eq!(vertices.len() % 6, 0, "output must contain complete line segments");
    let mut spans: Vec<([f32; 3], [f32; 3])> = Vec::new();
    let mut previous_end = None;
    for line in vertices.chunks_exact(6) {
        let start = [line[0], line[1], line[2]];
        let end = [line[3], line[4], line[5]];
        if previous_end != Some(start) {
            spans.push(([f32::INFINITY; 3], [f32::NEG_INFINITY; 3]));
        }
        let (min, max) = spans.last_mut().expect("each line belongs to a span");
        for point in [start, end] {
            for axis in 0..3 {
                min[axis] = min[axis].min(point[axis]);
                max[axis] = max[axis].max(point[axis]);
            }
        }
        previous_end = Some(end);
    }
    assert_eq!(spans.len(), 3, "all three alignments must emit distinct centerlines");

    // BBoxes are in renderer (X, elevation, -Y) metres. These broad bounds
    // come from the authored bridge file and verify each alignment's placement
    // and grade without pinning tessellation bytes or sample spacing.
    let expected = [
        ([-22.7, 50.0, -497.9], [20.9, 55.33, 0.0]),
        ([-24.2, 50.47, -497.94], [19.43, 55.79, -0.34]),
        ([-278.11, 43.85, -177.82], [225.90, 48.0, -126.95]),
    ];
    for (index, ((min, max), (expected_min, expected_max))) in
        spans.iter().zip(expected).enumerate()
    {
        for axis in 0..3 {
            assert!((min[axis] - expected_min[axis]).abs() < 0.75,
                "alignment {index} minimum axis {axis}: got {}, expected near {}", min[axis], expected_min[axis]);
            assert!((max[axis] - expected_max[axis]).abs() < 0.75,
                "alignment {index} maximum axis {axis}: got {}, expected near {}", max[axis], expected_max[axis]);
        }
    }
    let min_elevation = spans.iter().map(|(min, _)| min[1]).fold(f32::INFINITY, f32::min);
    let max_elevation = spans.iter().map(|(_, max)| max[1]).fold(f32::NEG_INFINITY, f32::max);
    assert!((min_elevation - 43.85).abs() < 0.1, "lowest centerline: {min_elevation}");
    assert!((max_elevation - 55.8).abs() < 0.1, "highest centerline: {max_elevation}");
}
