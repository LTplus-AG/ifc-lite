// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression test for issue #1167 ("weird wall hole cutting"): openings cut
//! from a rotated wall came out oversized and skewed to the world grid instead
//! of orthogonal to the wall, and — once that was fixed — a few openings
//! fragmented into rim slivers / cracks.
//!
//! Two coupled defects, both guarded here on a wall rotated 15° about Z (well
//! inside the old "axis-aligned" band) with one rectangular window punched
//! clean through both faces:
//!
//! 1. **Over-cut.** `classify_openings` used to route an opening onto the fast
//!    world-axis-aligned-AABB cut path whenever its extrusion direction was
//!    within ~18° of a world axis (`is_axis_aligned_direction` tolerance 0.95).
//!    A wall rotated in plan by up to ~18° (a façade off the project grid, or a
//!    whole building rotated relative to the world axes) was therefore cut by
//!    the world-axis bounding box of the rotated opening — strictly larger than
//!    the opening, removing wall outside the window. The tolerance is now
//!    cos(1°), so the opening is cut with its true oriented box and removes
//!    exactly the window volume (1.2 × 1.5 × 0.3 m = 0.54 m³).
//!
//! 2. **Fragmentation.** The oriented (exact-mesh) cut is sensitive to
//!    tessellation noise in the raw `IfcOpeningElement` mesh — extra collinear
//!    profile vertices (Revit/ArchiCAD segment their profiles) become rim
//!    slivers and hairline cracks on the tilted cut plane. The opening is now
//!    cut with its clean oriented bounding box, so a *tessellated* profile cuts
//!    just as cleanly (watertight, no needles) as a pristine one.

use ifc_lite_core::EntityDecoder;
use ifc_lite_geometry::{GeometryRouter, Mesh};
use rustc_hash::FxHashMap;

const WALL_ID: u32 = 100;
const OPENING_ID: u32 = 200;

/// Signed volume of a closed mesh via the divergence theorem, as a magnitude.
fn mesh_volume(mesh: &Mesh) -> f64 {
    let v = |i: u32| {
        let b = i as usize * 3;
        [
            mesh.positions[b] as f64,
            mesh.positions[b + 1] as f64,
            mesh.positions[b + 2] as f64,
        ]
    };
    (mesh
        .indices
        .chunks_exact(3)
        .map(|t| {
            let (a, b, c) = (v(t[0]), v(t[1]), v(t[2]));
            a[0] * (b[1] * c[2] - b[2] * c[1]) + a[1] * (b[2] * c[0] - b[0] * c[2])
                + a[2] * (b[0] * c[1] - b[1] * c[0])
        })
        .sum::<f64>()
        / 6.0)
        .abs()
}

/// (# unpaired directed edges, # high-aspect needle triangles). A watertight,
/// sliver-free mesh scores (0, 0). Open edges are counted on exact f32 bit keys
/// (the same closed-surface test the void batcher uses).
fn defects(m: &Mesh) -> (i64, usize) {
    use std::collections::HashMap;
    let key = |i: u32| {
        let b = i as usize * 3;
        (
            m.positions[b].to_bits(),
            m.positions[b + 1].to_bits(),
            m.positions[b + 2].to_bits(),
        )
    };
    let mut edges: HashMap<((u32, u32, u32), (u32, u32, u32)), i64> = HashMap::new();
    let p = |i: u32| {
        let b = i as usize * 3;
        [m.positions[b] as f64, m.positions[b + 1] as f64, m.positions[b + 2] as f64]
    };
    let mut needles = 0;
    for t in m.indices.chunks_exact(3) {
        let k = [key(t[0]), key(t[1]), key(t[2])];
        for (u, v) in [(0, 1), (1, 2), (2, 0)] {
            *edges.entry((k[u], k[v])).or_insert(0) += 1;
            *edges.entry((k[v], k[u])).or_insert(0) -= 1;
        }
        let (a, b, c) = (p(t[0]), p(t[1]), p(t[2]));
        let e = |u: [f64; 3], v: [f64; 3]| {
            ((u[0] - v[0]).powi(2) + (u[1] - v[1]).powi(2) + (u[2] - v[2]).powi(2)).sqrt()
        };
        let maxe = e(a, b).max(e(b, c)).max(e(c, a));
        let cr = [
            (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]),
            (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]),
            (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]),
        ];
        let area = 0.5 * (cr[0] * cr[0] + cr[1] * cr[1] + cr[2] * cr[2]).sqrt();
        if area > 1e-9 && maxe * maxe / (2.0 * area) > 50.0 {
            needles += 1;
        }
    }
    (edges.values().map(|c| c.abs()).sum(), needles)
}

/// A 4.0 × 0.3 × 2.5 m wall rotated 15° about world Z, with one rectangular
/// window (1.2 m wide × 1.5 m tall) extruded through both faces. The opening's
/// placement is relative to the wall, so it inherits the rotation — exactly how
/// an exporter encodes a window in a rotated wall. When `tessellated`, the
/// window profile carries a collinear midpoint on each edge (the segmented
/// profile real exporters emit), which used to fragment the tilted cut.
fn rotated_wall_with_window_ifc(angle_deg: f64, tessellated: bool) -> String {
    let c = angle_deg.to_radians().cos();
    let s = angle_deg.to_radians().sin();
    let opening_profile = if tessellated {
        "#120=IFCCARTESIANPOINT((-0.6,-0.75));\n\
         #121=IFCCARTESIANPOINT((0.,-0.75));\n\
         #122=IFCCARTESIANPOINT((0.6,-0.75));\n\
         #123=IFCCARTESIANPOINT((0.6,0.75));\n\
         #124=IFCCARTESIANPOINT((0.,0.75));\n\
         #125=IFCCARTESIANPOINT((-0.6,0.75));\n\
         #126=IFCPOLYLINE((#120,#121,#122,#123,#124,#125,#120));\n\
         #127=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,'W',#126);\n"
            .to_string()
    } else {
        "#127=IFCRECTANGLEPROFILEDEF(.AREA.,'W',#128,1.2,1.5);\n\
         #128=IFCAXIS2PLACEMENT2D(#129,#130);\n\
         #129=IFCCARTESIANPOINT((0.,0.));\n\
         #130=IFCDIRECTION((1.,0.));\n"
            .to_string()
    };
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
{opening_profile}#131=IFCEXTRUDEDAREASOLID(#127,#132,#133,1.0);
#132=IFCAXIS2PLACEMENT3D(#134,$,$);
#133=IFCDIRECTION((0.,0.,1.));
#134=IFCCARTESIANPOINT((0.,0.,0.));
#140=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid',(#131));
#141=IFCPRODUCTDEFINITIONSHAPE($,$,(#140));
#200=IFCOPENINGELEMENT('0001234567890123456790',#2,'Window',$,$,#110,#141,$,.OPENING.);
#300=IFCRELVOIDSELEMENT('0001234567890123456791',#2,$,$,#100,#200);
ENDSEC;
END-ISO-10303-21;
"#
    )
}

fn cut(content: &str) -> (Mesh, Mesh) {
    let mut decoder = EntityDecoder::new(content);
    let router = GeometryRouter::with_units(content, &mut decoder);
    let wall = decoder.decode_by_id(WALL_ID).expect("decode wall");
    let uncut = router.process_element(&wall, &mut decoder).expect("process wall");
    let mut void_index: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    void_index.insert(WALL_ID, vec![OPENING_ID]);
    let voided = router
        .process_element_with_voids(&wall, &mut decoder, &void_index)
        .expect("process wall with voids");
    (uncut, voided)
}

/// Defect 1: the rotated opening removes exactly the window volume, not the
/// oversized world-axis bounding box.
#[test]
fn rotated_wall_opening_is_not_overcut() {
    let (uncut, voided) = cut(&rotated_wall_with_window_ifc(15.0, false));
    let uncut_vol = mesh_volume(&uncut);
    let removed = uncut_vol - mesh_volume(&voided);

    assert!(
        (uncut_vol - 3.0).abs() < 1e-2,
        "uncut wall volume = {uncut_vol:.5}, expected 3.0 (4.0 × 0.3 × 2.5)"
    );
    let expected = 1.2 * 1.5 * 0.3;
    assert!(
        (removed - expected).abs() < 0.04,
        "opening removed {removed:.5} m³ (expected {expected:.5}); a value well \
         above {expected:.2} means the 15°-rotated opening was cut as its \
         oversized world-axis bounding box instead of its true oriented box \
         (issue #1167)"
    );
}

/// Defect 2: a tessellated (segmented-profile) opening on the same rotated wall
/// cuts cleanly — watertight, no rim needles — because it is cut with its clean
/// oriented bounding box rather than the raw tessellated mesh. Pre-fix this
/// produced open edges and high-aspect slivers (the "fragmented holes").
#[test]
fn rotated_tessellated_opening_does_not_fragment() {
    let (uncut, voided) = cut(&rotated_wall_with_window_ifc(15.0, true));
    let removed = mesh_volume(&uncut) - mesh_volume(&voided);
    let expected = 1.2 * 1.5 * 0.3;
    assert!(
        (removed - expected).abs() < 0.04,
        "tessellated rotated opening removed {removed:.5} m³ (expected {expected:.5})"
    );

    let (open_edges, needles) = defects(&voided);
    assert_eq!(
        open_edges, 0,
        "tessellated rotated opening left {open_edges} unpaired edges — the \
         tilted cut fragmented (issue #1167); it must be cut with its clean \
         oriented bounding box"
    );
    assert_eq!(
        needles, 0,
        "tessellated rotated opening left {needles} sliver/needle triangles \
         (issue #1167)"
    );
}
