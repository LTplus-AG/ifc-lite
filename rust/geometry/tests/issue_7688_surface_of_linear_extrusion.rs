// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7688 PROC-S6 + the RTC half of #7678 PROC-S23:
//! `SurfaceOfLinearExtrusionProcessor` was documented and exported but never
//! registered, so an `IfcSurfaceOfLinearExtrusion` item was refused as an
//! unsupported type, and its RTC handling could never run.
//!
//! Registered, it must:
//! - mesh the swept strip (asserted by AREA: curve length x depth);
//! - rebase national-grid coordinates in f64 before the f32 narrowing, whether
//!   the magnitude sits in the curve points or in the Position;
//! - refuse a curve it cannot read rather than mesh a different one, so the
//!   item stays visibly unmeshed exactly as it was while unregistered.

use ifc_lite_core::EntityDecoder;
use ifc_lite_geometry::{GeometryRouter, Mesh};

/// LV95 magnitude: one f32 ULP here is 0.25 m.
const SITE: [f64; 3] = [2_600_000.0, 1_200_000.0, 0.0];

/// A 12 mm x 5 mm strip: the curve runs 0.4 -> 0.412 in x at y = 0.3, swept
/// 5 mm along +Z. Sub-ULP at SITE, so a narrow-first mesh collapses it.
const STRIP: [[f64; 3]; 4] = [
    [0.4, 0.3, 0.0],
    [0.412, 0.3, 0.0],
    [0.4, 0.3, 0.005],
    [0.412, 0.3, 0.005],
];

/// One proxy at the identity placement whose Body is one surface item. The
/// curve points are `curve_offset` + the strip's base, and the surface's
/// Position sits at `position_offset`.
fn element(curve_offset: [f64; 3], position_offset: [f64; 3]) -> String {
    element_with_curve(curve_offset, position_offset, "#12=IFCPOLYLINE((#10,#11));")
}

/// [`element`] with the swept curve `#12` given as a STEP record.
fn element_with_curve(curve_offset: [f64; 3], position_offset: [f64; 3], curve: &str) -> String {
    let p = |x: f64, y: f64| format!("({:.6},{:.6})", x + curve_offset[0], y + curve_offset[1]);
    format!(
        "#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);#3=IFCLOCALPLACEMENT($,#2);\
         #10=IFCCARTESIANPOINT({});#11=IFCCARTESIANPOINT({});{curve}\
         #13=IFCARBITRARYOPENPROFILEDEF(.CURVE.,$,#12);\
         #14=IFCCARTESIANPOINT(({:.6},{:.6},{:.6}));#15=IFCAXIS2PLACEMENT3D(#14,$,$);\
         #16=IFCDIRECTION((0.,0.,1.));\
         #900=IFCSURFACEOFLINEAREXTRUSION(#13,#15,#16,0.005);\
         #1000=IFCSHAPEREPRESENTATION($,'Body','Surface3D',(#900));\
         #1001=IFCPRODUCTDEFINITIONSHAPE($,$,(#1000));\
         #1002=IFCBUILDINGELEMENTPROXY('0000000000000000000000',$,'Strip',$,$,#3,#1001,$);",
        p(0.4, 0.3),
        p(0.412, 0.3),
        position_offset[0],
        position_offset[1],
        position_offset[2],
    )
}

fn process(source: &str, rtc: [f64; 3]) -> Mesh {
    let mut decoder = EntityDecoder::new(source);
    let element = decoder.decode_by_id(1002).unwrap();
    let mut router = GeometryRouter::with_scale_and_local_frame(1.0, false);
    router.set_rtc_offset((rtc[0], rtc[1], rtc[2]));
    router.process_element(&element, &mut decoder).expect("the surface element meshes")
}

fn world(mesh: &Mesh, vertex: &[f32], axis: usize) -> f64 {
    vertex[axis] as f64 + mesh.origin[axis]
}

/// Total triangle area, in the RTC frame (f64 over the published vertices).
fn area(mesh: &Mesh) -> f64 {
    let v = |i: u32| {
        let c = &mesh.positions[i as usize * 3..i as usize * 3 + 3];
        nalgebra::Vector3::new(world(mesh, c, 0), world(mesh, c, 1), world(mesh, c, 2))
    };
    mesh.indices
        .chunks_exact(3)
        .map(|t| (v(t[1]) - v(t[0])).cross(&(v(t[2]) - v(t[0]))).norm() / 2.0)
        .sum()
}

fn assert_strip(mesh: &Mesh, label: &str) {
    for p in STRIP {
        assert!(
            mesh.positions
                .chunks_exact(3)
                .any(|v| (0..3).all(|axis| (world(mesh, v, axis) - p[axis]).abs() < 1e-5)),
            "{label}: corner {p:?} lost; positions {:?} origin {:?}",
            mesh.positions,
            mesh.origin
        );
    }
    let area = area(mesh);
    assert!((area - 0.012 * 0.005).abs() < 1e-9, "{label}: area {area}");
}

/// The near-origin strip meshes: the type is routed at all.
#[test]
fn issue_7688_proc_s6_a_surface_of_linear_extrusion_is_meshed() {
    let mesh = process(&element([0.0; 3], [0.0; 3]), [0.0; 3]);
    assert_strip(&mesh, "near origin");
}

/// National-grid curve points and a national-grid Position both keep their
/// 12 mm x 5 mm detail: the processor subtracts RTC in f64.
#[test]
fn issue_7688_proc_s23_national_grid_surfaces_rebase_before_narrowing() {
    let cases = [("curve points at LV95", SITE, [0.0; 3]), ("Position at LV95", [0.0; 3], SITE)];
    for (label, curve_offset, position_offset) in cases {
        let mesh = process(&element(curve_offset, position_offset), SITE);
        assert!(mesh.rtc_applied, "{label}: the RTC hook must run");
        assert_strip(&mesh, label);
    }
}

/// A curve the walk does not read is refused, never read as raw bytes or
/// silently shortened: the item errors, as it did while unregistered.
#[test]
fn issue_7688_an_unreadable_swept_curve_refuses_the_item() {
    let cases = [
        // A degree-2 B-spline: the old raw-byte fallback read its first
        // nested list, the CONTROL POLYGON, and meshed that instead.
        (
            "B-spline curve",
            "#17=IFCCARTESIANPOINT((0.406,0.31));\
             #12=IFCBSPLINECURVEWITHKNOTS(2,(#10,#17,#11),.UNSPECIFIED.,.F.,.F.,(3,3),(0.,1.),.UNSPECIFIED.);",
        ),
        // A composite whose second segment is unreadable: skipping it meshed
        // the first segment alone, as if it were the authored curve.
        (
            "composite with an unreadable segment",
            "#30=IFCPOLYLINE((#10,#11));#31=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#30);\
             #32=IFCCOMPOSITECURVESEGMENT(.CONTINUOUS.,.T.,#99);\
             #12=IFCCOMPOSITECURVE((#31,#32),.F.);",
        ),
    ];
    for (label, curve) in cases {
        let source = element_with_curve([0.0; 3], [0.0; 3], curve);
        let mut decoder = EntityDecoder::new(&source);
        let element = decoder.decode_by_id(1002).unwrap();
        let router = GeometryRouter::with_scale_and_local_frame(1.0, false);
        let result = router.process_element(&element, &mut decoder);
        assert!(
            result.as_ref().map_or(true, |m| m.positions.is_empty()),
            "{label}: must not mesh a different curve, got {:?}",
            result.map(|m| m.positions)
        );
    }
}

/// Review of #7769: every degenerate or off-plane input is REFUSED (an `Err`
/// the caller counts), never published as an empty or flattened mesh. Main
/// refused the whole type, so none of these may fail open.
#[test]
fn issue_7688_degenerate_surfaces_are_refused_not_emptied() {
    let line = "#12=IFCPOLYLINE((#10,#11));";
    let swap = |from: &str, to: &str| element([0.0; 3], [0.0; 3]).replace(from, to);
    let cases = [
        ("zero depth", swap("#16,0.005)", "#16,0.)")),
        ("negative depth", swap("#16,0.005)", "#16,-0.005)")),
        ("direction along the curve", swap("#16=IFCDIRECTION((0.,0.,1.))", "#16=IFCDIRECTION((1.,0.,0.))")),
        ("one-point curve", swap(line, "#12=IFCPOLYLINE((#10));")),
        ("coincident points", swap(line, "#12=IFCPOLYLINE((#10,#10));")),
        ("empty composite", swap(line, "#12=IFCCOMPOSITECURVE((),.F.);")),
        (
            "point off the profile plane",
            swap(line, "#17=IFCCARTESIANPOINT((0.412,0.3,7.));#12=IFCPOLYLINE((#10,#17));"),
        ),
    ];
    for (label, source) in cases {
        let mut decoder = EntityDecoder::new(&source);
        let element = decoder.decode_by_id(1002).unwrap();
        let router = GeometryRouter::with_scale_and_local_frame(1.0, false);
        let result = router.process_element(&element, &mut decoder);
        assert!(result.is_err(), "{label}: must be refused, got {:?}", result.map(|m| m.positions));
    }
}

/// Review of #7769: `ExtrudedDirection` is in the Position frame. A Position
/// whose Axis is world -Y sweeps local +Z along world -Y, not world +Z.
#[test]
fn issue_7688_extruded_direction_is_in_the_position_frame() {
    let source = element([0.0; 3], [0.0; 3]).replace(
        "#15=IFCAXIS2PLACEMENT3D(#14,$,$);",
        "#18=IFCDIRECTION((0.,-1.,0.));#19=IFCDIRECTION((1.,0.,0.));#15=IFCAXIS2PLACEMENT3D(#14,#18,#19);",
    );
    let mesh = process(&source, [0.0; 3]);
    // Local (x, y, z) maps to world (x, z, -y): the curve at local y = 0.3
    // lies at world z = 0.3, and the 5 mm sweep runs to world y = -0.005.
    for p in [[0.4, 0.0, 0.3], [0.412, 0.0, 0.3], [0.4, -0.005, 0.3], [0.412, -0.005, 0.3]] {
        assert!(
            mesh.positions
                .chunks_exact(3)
                .any(|v| (0..3).all(|axis| (world(&mesh, v, axis) - p[axis]).abs() < 1e-6)),
            "corner {p:?} missing; positions {:?}",
            mesh.positions
        );
    }
}

/// Review of #7769: registering the processor must not turn an open surface
/// into a boolean cutter. Main recorded it as an unsupported operand and kept
/// the host whole; meshed, it cut the box open along the strip.
#[test]
fn issue_7688_a_surface_is_not_a_boolean_operand() {
    let source = "#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);\
         #40=IFCAXIS2PLACEMENT2D(#41,$);#41=IFCCARTESIANPOINT((0.,0.));\
         #42=IFCRECTANGLEPROFILEDEF(.AREA.,$,#40,1.,1.);#43=IFCDIRECTION((0.,0.,1.));\
         #50=IFCEXTRUDEDAREASOLID(#42,#2,#43,1.);\
         #10=IFCCARTESIANPOINT((-1.,0.));#11=IFCCARTESIANPOINT((1.,0.));#12=IFCPOLYLINE((#10,#11));\
         #13=IFCARBITRARYOPENPROFILEDEF(.CURVE.,$,#12);\
         #14=IFCCARTESIANPOINT((0.,0.,-1.));#15=IFCAXIS2PLACEMENT3D(#14,$,$);\
         #900=IFCSURFACEOFLINEAREXTRUSION(#13,#15,#43,3.);\
         #60=IFCBOOLEANRESULT(.DIFFERENCE.,#50,#900);";
    let mut decoder = EntityDecoder::new(source);
    let entity = decoder.decode_by_id(60).unwrap();
    let router = GeometryRouter::with_scale_and_local_frame(1.0, false);
    let mesh = router.process_representation_item(&entity, &mut decoder).expect("host survives");
    assert!((area(&mesh) - 6.0).abs() < 1e-6, "the unit box stays whole, area {}", area(&mesh));
    let failures = format!("{:?}", router.take_csg_failures());
    assert!(failures.contains("UnsupportedOperand(\"IfcSurfaceOfLinearExtrusion\")"), "{failures}");
}
