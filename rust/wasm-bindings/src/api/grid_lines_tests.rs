// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Tests for `api::grid_lines` - extracted from an inline `#[cfg(test)]`
//! block so `grid_lines.rs` stays inside the module-size ratchet while the
//! render-frame fixtures below grow. Included from `grid_lines.rs` with
//! `#[cfg(test)] #[path = "grid_lines_tests.rs"] mod tests;`, so `super`
//! still resolves to the `grid_lines` module.

use super::*;

// Minimal IFC4 grid: one IfcGrid (placement at origin) with a single
// IfcGridAxis "A" whose AxisCurve is a 2-point IfcPolyline
// (0,0)->(10,0), metres.
const LOCAL_GRID: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCCARTESIANPOINT((0.,0.,0.));
#2=IFCDIRECTION((0.,0.,1.));
#3=IFCDIRECTION((1.,0.,0.));
#4=IFCAXIS2PLACEMENT3D(#1,#2,#3);
#5=IFCLOCALPLACEMENT($,#4);
#10=IFCCARTESIANPOINT((0.,0.));
#11=IFCCARTESIANPOINT((10.,0.));
#12=IFCPOLYLINE((#10,#11));
#13=IFCGRIDAXIS('A',#12,.T.);
#20=IFCGRID('0aBcDeFgHiJkLmNoPqRsT0',$,'Grid',$,$,#5,$,(#13),$,$);
ENDSEC;
END-ISO-10303-21;
"#;

#[test]
fn extracts_local_grid_axis() {
    let axes = extract_grid_axes(LOCAL_GRID);
    assert_eq!(axes.len(), 1, "expected one grid axis");
    let a = &axes[0];
    assert_eq!(a.tag, "A", "axis tag preserved");
    // Start (0,0,0) → renderer (0,0,-0).
    assert!(a.start[0].abs() < 1e-4, "start x≈0, got {}", a.start[0]);
    assert!(a.start[1].abs() < 1e-4, "start y≈0, got {}", a.start[1]);
    assert!(a.start[2].abs() < 1e-4, "start z≈0, got {}", a.start[2]);
    // End (10,0,0) IFC → renderer Y-up (10, 0, -0).
    assert!(
        (a.end[0] - 10.0).abs() < 1e-3,
        "end renderer-x ≈10, got {}",
        a.end[0]
    );
    assert!(a.end[1].abs() < 1e-3, "end elevation ≈0, got {}", a.end[1]);
}

#[test]
fn flat_line_list_is_even_xyz_triples() {
    // Mirror the flat line-list `parseGridLines` builds, without invoking
    // the wasm method (js_sys types don't link on the native test target).
    let axes = extract_grid_axes(LOCAL_GRID);
    let mut verts: Vec<f32> = Vec::new();
    for a in &axes {
        verts.extend_from_slice(&a.start);
        verts.extend_from_slice(&a.end);
    }
    assert!(!verts.is_empty(), "grid must emit line vertices");
    assert_eq!(verts.len() % 3, 0, "vertices must be xyz triples");
    assert_eq!((verts.len() / 3) % 2, 0, "line-list = even vertex count");
    // One axis → one segment → 2 vertices → 6 floats.
    assert_eq!(verts.len(), 6, "one axis → 6 floats");
}

#[test]
fn empty_for_no_grid() {
    let none = "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n";
    assert!(extract_grid_axes(none).is_empty());
}

#[test]
fn georeferenced_grid_rebased_near_origin() {
    // Grid placement carries a ~10.4 km survey offset (metres here for
    // simplicity); the axis point sits 10 m further along. After RTC the
    // axis must land near the origin, not at ~10 km.
    let content = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCCARTESIANPOINT((0.,0.,0.));
#2=IFCDIRECTION((0.,0.,1.));
#3=IFCDIRECTION((1.,0.,0.));
#4=IFCAXIS2PLACEMENT3D(#1,#2,#3);
#5=IFCLOCALPLACEMENT($,#4);
/* a wall far out at survey coords so RTC detection trips (>10 km) */
#6=IFCCARTESIANPOINT((10400000.,2000000.,0.));
#7=IFCAXIS2PLACEMENT3D(#6,#2,#3);
#8=IFCLOCALPLACEMENT($,#7);
#9=IFCPRODUCTDEFINITIONSHAPE($,$,(#41));
#40=IFCCARTESIANPOINT((10400000.,2000000.,0.));
#41=IFCSHAPEREPRESENTATION($,'Body','Curve2D',(#42));
#42=IFCPOLYLINE((#40,#40));
#43=IFCWALL('1WaLLWaLLWaLLWaLLWaLL00',$,'W',$,$,#8,#9,$,$);
/* grid placed at the same survey frame */
#50=IFCCARTESIANPOINT((10400000.,2000000.,0.));
#51=IFCAXIS2PLACEMENT3D(#50,#2,#3);
#52=IFCLOCALPLACEMENT($,#51);
#10=IFCCARTESIANPOINT((0.,0.));
#11=IFCCARTESIANPOINT((10.,0.));
#12=IFCPOLYLINE((#10,#11));
#13=IFCGRIDAXIS('A',#12,.T.);
#20=IFCGRID('0aBcDeFgHiJkLmNoPqRsT0',$,'Grid',$,$,#52,$,(#13),$,$);
ENDSEC;
END-ISO-10303-21;
"#;
    let axes = extract_grid_axes(content);
    assert_eq!(axes.len(), 1, "expected one grid axis");
    let a = &axes[0];
    // The grid origin maps to ~origin after RTC (within a few metres of the
    // wall sample used to detect the offset).
    for c in a.start.iter().chain(a.end.iter()) {
        assert!(
            c.abs() < 1000.0,
            "render-frame coord must be near origin after RTC, got {c}"
        );
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Render-frame conversion (`to_render_frame`)
// ═══════════════════════════════════════════════════════════════════════════
//
// Every fixture above is metres (unit_scale exactly 1), RTC-free (offset
// exactly 0) and has an axis lying on the X axis with `y = z = 0`, and the
// georeferenced one asserts only `|coord| < 1000`. Between them, three
// independent halves of `to_render_frame` are unobservable: dropping the
// `unit_scale` multiply, dropping the negation on the renderer Z, and reading
// the wrong matrix row for the renderer Y all pass the suite unchanged.
//
// The fixtures below are MILLIMETRE files whose axis endpoint has three
// pairwise-distinct non-zero components, so the scale, the axis mapping
// `(x, y, z)_ifc -> (x, z, -y)_render` and the placement rows each have to be
// right on their own.

/// A millimetre-unit grid: `IfcSIUnit` with the `.MILLI.` prefix, so
/// `unit_scale` is 0.001 and every file coordinate is 1000x its metre value.
/// `placement` is spliced in as the grid's `ObjectPlacement`.
fn millimetre_grid(placement_body: &str, placement_ref: &str) -> String {
    format!(
        r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCCARTESIANPOINT((0.,0.,0.));
#2=IFCDIRECTION((0.,0.,1.));
#3=IFCDIRECTION((1.,0.,0.));
#4=IFCAXIS2PLACEMENT3D(#1,#2,#3);
#5=IFCLOCALPLACEMENT($,#4);
#6=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#7=IFCUNITASSIGNMENT((#6));
#8=IFCPROJECT('0PrOjEcTpRoJeCtPrOjEc',$,'P',$,$,$,$,$,#7);
{placement_body}
#10=IFCCARTESIANPOINT((0.,0.,0.));
#11=IFCCARTESIANPOINT((10000.,4000.,2000.));
#12=IFCPOLYLINE((#10,#11));
#13=IFCGRIDAXIS('A',#12,.T.);
#20=IFCGRID('0aBcDeFgHiJkLmNoPqRsT0',$,'Grid',$,$,{placement_ref},$,(#13),$,$);
ENDSEC;
END-ISO-10303-21;
"#
    )
}

/// Identity placement: the endpoint is nothing but unit scale + the Z-up ->
/// Y-up swap. `(10000, 4000, 2000)` mm is `(10, 4, 2)` m in the IFC frame, so
/// the renderer sees `(x, z_ifc, -y_ifc) = (10, 2, -4)`.
///
/// The three components are pairwise distinct and none is zero, so no
/// permutation, sign flip or dropped scale reproduces this triple.
#[test]
fn millimetre_axis_endpoint_is_scaled_and_yup_swapped() {
    let axes = extract_grid_axes(&millimetre_grid("", "#5"));
    assert_eq!(axes.len(), 1, "expected one grid axis");
    let end = axes[0].end;
    assert!(
        (end[0] - 10.0).abs() < 1e-3,
        "renderer x = ifc x in metres (10), got {}",
        end[0]
    );
    assert!(
        (end[1] - 2.0).abs() < 1e-3,
        "renderer y (elevation) = ifc z in metres (2), got {}",
        end[1]
    );
    assert!(
        (end[2] + 4.0).abs() < 1e-3,
        "renderer z = -(ifc y) in metres (-4), got {}",
        end[2]
    );
    // The start is the polyline's origin, which no scale or swap can move.
    assert_eq!(axes[0].start, [0.0, 0.0, -0.0]);
}

/// The same axis under a grid placement translated by `(5, 6, 7)` m. The
/// translation arrives from `resolve_scaled_placement` ALREADY in metres while
/// the local point is still in file units, so the local point must be scaled
/// before the matrix is applied — scaling after (or not at all) moves the
/// endpoint by kilometres here. World `(15, 10, 9)` IFC -> renderer
/// `(15, 9, -10)`.
///
/// The three translation components are also pairwise distinct, so reading the
/// wrong translation slot (`matrix[12]`/`[13]`/`[14]`) cannot pass either.
#[test]
fn millimetre_axis_endpoint_composes_with_a_translated_placement() {
    let content = millimetre_grid(
        "#50=IFCCARTESIANPOINT((5000.,6000.,7000.));\n\
         #51=IFCAXIS2PLACEMENT3D(#50,#2,#3);\n\
         #52=IFCLOCALPLACEMENT($,#51);",
        "#52",
    );
    let axes = extract_grid_axes(&content);
    assert_eq!(axes.len(), 1, "expected one grid axis");
    let start = axes[0].start;
    let end = axes[0].end;
    // Local origin lands on the placement itself: IFC (5,6,7) -> (5, 7, -6).
    assert!((start[0] - 5.0).abs() < 1e-3, "start renderer x = 5, got {}", start[0]);
    assert!((start[1] - 7.0).abs() < 1e-3, "start renderer y = 7, got {}", start[1]);
    assert!((start[2] + 6.0).abs() < 1e-3, "start renderer z = -6, got {}", start[2]);
    // Far endpoint: IFC (5+10, 6+4, 7+2) = (15, 10, 9) -> (15, 9, -10).
    assert!((end[0] - 15.0).abs() < 1e-3, "end renderer x = 15, got {}", end[0]);
    assert!((end[1] - 9.0).abs() < 1e-3, "end renderer y = 9, got {}", end[1]);
    assert!((end[2] + 10.0).abs() < 1e-3, "end renderer z = -10, got {}", end[2]);
}

/// The 3D grid overlay and the symbolic overlay are two written-out copies of
/// one conversion, and both modules' docs claim they agree axis for axis. A
/// zero northing is where that is easiest to break: negating it yields -0.0,
/// which compares equal to 0.0 and so slips past every assertion here, while
/// the symbolic side's pinned goldens record sign of zero deliberately. Pin
/// the sign so the two cannot drift apart unnoticed.
#[test]
fn to_render_frame_does_not_emit_negative_zero_for_a_zero_northing() {
    let identity = [
        1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
    ];
    let out = to_render_frame([3.0, 0.0, 2.0], 1.0, &identity, (0.0, 0.0, 0.0));
    assert_eq!(out[2], 0.0);
    assert!(
        !out[2].is_sign_negative(),
        "a zero northing produced -0.0, so this no longer matches RenderFrameRebase::plan",
    );

    // A genuine negative northing must still flip, ruling out an abs() mis-fix.
    let flipped = to_render_frame([0.0, 4.0, 0.0], 1.0, &identity, (0.0, 0.0, 0.0));
    assert_eq!(flipped[2], -4.0);
}
