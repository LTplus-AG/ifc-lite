// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression test for issue #1167 ("weird wall hole cutting"): openings cut
//! from a rotated wall came out oversized and skewed to the world grid instead
//! of orthogonal to the wall.
//!
//! Root cause: `classify_openings` routed an opening onto the fast
//! world-axis-aligned-AABB `Rectangular` cut path whenever its extrusion
//! direction (and inferred frame) were within ~18° of a world axis — the old
//! `is_axis_aligned_direction` tolerance of 0.95. A wall rotated in plan by up
//! to ~18° (a façade a few degrees off the project grid, or a whole building
//! rotated relative to the world axes) therefore had its window cut by the
//! world-axis-aligned *bounding box* of the rotated opening box. That AABB is
//! strictly larger than the real opening, so the cut removed wall material
//! outside the window — a hole bigger than the window and not orthogonal to
//! the wall.
//!
//! This fixture is a wall rotated 15° about Z (well inside the old 0.95 band)
//! with a single rectangular window that punches clean through both faces. A
//! correct, *oriented* cut removes exactly the window volume
//! (1.2 m × 1.5 m × 0.3 m wall thickness = 0.54 m³). The buggy axis-aligned
//! AABB cut removes appreciably more.

use ifc_lite_core::EntityDecoder;
use ifc_lite_geometry::{GeometryRouter, Mesh};
use rustc_hash::FxHashMap;

const WALL_ID: u32 = 100;
const OPENING_ID: u32 = 200;

/// Signed volume of a closed mesh via the divergence theorem (same invariant
/// as `wall_opening_cut_regression`). Returned as a magnitude so winding
/// doesn't matter.
fn mesh_volume(mesh: &Mesh) -> f64 {
    let v = |i: u32| {
        let b = i as usize * 3;
        [
            mesh.positions[b] as f64,
            mesh.positions[b + 1] as f64,
            mesh.positions[b + 2] as f64,
        ]
    };
    let vol: f64 = mesh
        .indices
        .chunks_exact(3)
        .map(|t| {
            let (a, b, c) = (v(t[0]), v(t[1]), v(t[2]));
            a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2])
                + a[2] * (b[0] * c[1] - b[1] * c[0])
        })
        .sum::<f64>()
        / 6.0;
    vol.abs()
}

/// A 4.0 × 0.3 × 2.5 m wall rotated 15° about world Z, with one rectangular
/// window opening (1.2 m wide × 1.5 m tall) extruded through both faces. The
/// opening's placement is relative to the wall, so it inherits the rotation —
/// exactly how an exporter encodes a window in a rotated wall.
fn rotated_wall_with_window_ifc() -> String {
    // cos/sin(15°) — keeps the wall's thickness axis 15° off world X/Y, inside
    // the old (0.95 ≈ 18°) "axis-aligned" band that triggered the AABB cut.
    let c = 0.9659258262890683_f64; // cos(15°)
    let s = 0.25881904510252074_f64; // sin(15°)
    format!(
        r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('test.ifc','2024-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('1234567890123456789012',#2,'Test',$,$,$,$,(#10),#7);
#2=IFCOWNERHISTORY(#3,#4,$,.ADDED.,$,$,$,0);
#3=IFCPERSONANDORGANIZATION(#5,#6,$);
#4=IFCAPPLICATION(#6,'1.0','Test','Test');
#5=IFCPERSON($,'Test',$,$,$,$,$,$);
#6=IFCORGANIZATION($,'Test',$,$,$);
#7=IFCUNITASSIGNMENT((#8,#9));
#8=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#9=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);
#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#11,$);
#11=IFCAXIS2PLACEMENT3D(#12,$,$);
#12=IFCCARTESIANPOINT((0.,0.,0.));
#13=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#10,$,.MODEL_VIEW.,$);
#20=IFCLOCALPLACEMENT($,#21);
#21=IFCAXIS2PLACEMENT3D(#22,#23,#24);
#22=IFCCARTESIANPOINT((0.,0.,0.));
#23=IFCDIRECTION((0.,0.,1.));
#24=IFCDIRECTION(({c},{s},0.));
#30=IFCRECTANGLEPROFILEDEF(.AREA.,'WallProfile',#31,4.0,0.3);
#31=IFCAXIS2PLACEMENT2D(#32,#33);
#32=IFCCARTESIANPOINT((0.,0.));
#33=IFCDIRECTION((1.,0.));
#40=IFCEXTRUDEDAREASOLID(#30,#41,#42,2.5);
#41=IFCAXIS2PLACEMENT3D(#43,$,$);
#42=IFCDIRECTION((0.,0.,1.));
#43=IFCCARTESIANPOINT((0.,0.,0.));
#50=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid',(#40));
#51=IFCPRODUCTDEFINITIONSHAPE($,$,(#50));
#100=IFCWALL('0001234567890123456789',#2,'RotatedWall',$,$,#20,#51,'Test',$);
#110=IFCLOCALPLACEMENT(#20,#111);
#111=IFCAXIS2PLACEMENT3D(#112,#113,#114);
#112=IFCCARTESIANPOINT((0.,-0.5,1.25));
#113=IFCDIRECTION((0.,1.,0.));
#114=IFCDIRECTION((1.,0.,0.));
#120=IFCRECTANGLEPROFILEDEF(.AREA.,'WindowProfile',#121,1.2,1.5);
#121=IFCAXIS2PLACEMENT2D(#122,#123);
#122=IFCCARTESIANPOINT((0.,0.));
#123=IFCDIRECTION((1.,0.));
#130=IFCEXTRUDEDAREASOLID(#120,#131,#132,1.0);
#131=IFCAXIS2PLACEMENT3D(#133,$,$);
#132=IFCDIRECTION((0.,0.,1.));
#133=IFCCARTESIANPOINT((0.,0.,0.));
#140=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid',(#130));
#141=IFCPRODUCTDEFINITIONSHAPE($,$,(#140));
#200=IFCOPENINGELEMENT('0001234567890123456790',#2,'Window',$,$,#110,#141,$,.OPENING.);
#300=IFCRELVOIDSELEMENT('0001234567890123456791',#2,$,$,#100,#200);
ENDSEC;
END-ISO-10303-21;
"#
    )
}

#[test]
fn rotated_wall_opening_is_not_overcut() {
    let content = rotated_wall_with_window_ifc();
    let mut decoder = EntityDecoder::new(&content);
    let router = GeometryRouter::with_units(&content, &mut decoder);

    let wall = decoder.decode_by_id(WALL_ID).expect("decode wall");
    let uncut = router
        .process_element(&wall, &mut decoder)
        .expect("process wall");
    let uncut_vol = mesh_volume(&uncut);

    let mut void_index: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    void_index.insert(WALL_ID, vec![OPENING_ID]);
    let voided = router
        .process_element_with_voids(&wall, &mut decoder, &void_index)
        .expect("process wall with voids");
    let voided_vol = mesh_volume(&voided);

    let removed = uncut_vol - voided_vol;
    eprintln!("[issue-1167] uncut={uncut_vol:.5} voided={voided_vol:.5} removed={removed:.5}");

    // Uncut wall is a 4.0 × 0.3 × 2.5 m box = 3.0 m³.
    assert!(
        (uncut_vol - 3.0).abs() < 1e-2,
        "uncut wall volume = {uncut_vol:.5}, expected 3.0"
    );

    // The cut must actually have removed material (guards against a no-op).
    assert!(
        removed > 0.40,
        "opening barely cut the wall: removed only {removed:.5} m³"
    );

    // A correct ORIENTED cut removes exactly window × thickness =
    // 1.2 · 1.5 · 0.3 = 0.54 m³. The buggy world-axis AABB cut of the rotated
    // opening removes appreciably more (it carves wall material outside the
    // window). Pin the removed volume tight enough to exclude the over-cut.
    let expected = 1.2 * 1.5 * 0.3;
    assert!(
        (removed - expected).abs() < 0.04,
        "opening removed {removed:.5} m³ (expected {expected:.5}); a value well \
         above {expected:.2} means the 15°-rotated opening was cut as its \
         oversized world-axis bounding box instead of its true oriented box \
         (issue #1167)"
    );
}
