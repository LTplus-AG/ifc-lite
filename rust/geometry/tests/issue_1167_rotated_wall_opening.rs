// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Synthetic regression tests for issue #1167 ("weird wall hole cutting").
//! (`issue_1167_real_wall` pins the same fix on a real isolated wall.)
//!
//! A wall rotated in plan had its openings cut wrong two ways: (1) over-cut —
//! openings within ~18° of a world axis took the world-axis-aligned-AABB path,
//! whose box is bigger than the rotated opening; (2) fragmentation — the tilted
//! exact cut left rim slivers/cracks. The fix tightens the axis tolerance to
//! cos(1°) and cuts a plan-rotated wall in its own axis-aligned, origin-centred
//! frame, then rotates the result back — so it cuts like a straight wall.
//!
//! Fixture: a 4.0 × 0.3 × 2.5 m wall rotated about Z with one rectangular
//! window (1.2 × 1.5 m) through both faces, placed relative to the wall so it
//! inherits the rotation. Correct removed volume = 1.2·1.5·0.3 = 0.54 m³.

use ifc_lite_core::EntityDecoder;
use ifc_lite_geometry::{GeometryRouter, Mesh};
use rustc_hash::FxHashMap;

const WALL_ID: u32 = 100;
const OPENING_ID: u32 = 200;
const WINDOW_VOLUME: f64 = 1.2 * 1.5 * 0.3;

/// Signed volume of a closed mesh via the divergence theorem, as a magnitude.
fn mesh_volume(mesh: &Mesh) -> f64 {
    let v = |i: u32| {
        let b = i as usize * 3;
        [mesh.positions[b] as f64, mesh.positions[b + 1] as f64, mesh.positions[b + 2] as f64]
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

/// `(unpaired directed edges, needle triangles)` — `(0, 0)` is watertight and
/// sliver-free. Edges pair on a 0.1 mm grid (the cut runs in a rotated frame;
/// the rotate-back jitters shared vertices in the low f32 digits, so exact-bit
/// pairing over-reports — 0.1 mm is far below any real gap).
fn defects(m: &Mesh) -> (i64, usize) {
    use std::collections::HashMap;
    let q = |i: u32| {
        let b = i as usize * 3;
        (
            (m.positions[b] * 1.0e4).round() as i64,
            (m.positions[b + 1] * 1.0e4).round() as i64,
            (m.positions[b + 2] * 1.0e4).round() as i64,
        )
    };
    let p = |i: u32| {
        let b = i as usize * 3;
        [m.positions[b] as f64, m.positions[b + 1] as f64, m.positions[b + 2] as f64]
    };
    let mut edges: HashMap<((i64, i64, i64), (i64, i64, i64)), i64> = HashMap::new();
    let mut needles = 0;
    for t in m.indices.chunks_exact(3) {
        let k = [q(t[0]), q(t[1]), q(t[2])];
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

/// Wall rotated `angle_deg` about Z with one window through both faces. With
/// `tessellated`, the window profile carries a collinear midpoint on each edge.
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
/// oversized world-axis bounding box (which removed ≈ 0.66 m³ before the fix).
#[test]
fn rotated_wall_opening_is_not_overcut() {
    let (uncut, voided) = cut(&rotated_wall_with_window_ifc(15.0, false));
    let uncut_vol = mesh_volume(&uncut);
    let removed = uncut_vol - mesh_volume(&voided);

    assert!(
        (uncut_vol - 3.0).abs() < 1e-2,
        "uncut wall volume = {uncut_vol:.5}, expected 3.0 (4.0 × 0.3 × 2.5)"
    );
    assert!(
        (removed - WINDOW_VOLUME).abs() < 0.04,
        "opening removed {removed:.5} m³ (expected {WINDOW_VOLUME:.5}); well above \
         means the rotated opening was cut as its oversized world-axis bounding box"
    );
}

/// Defect 2: at any in-plan rotation, a window — including a tessellated
/// (segmented-profile) one — cuts watertight with no rim slivers and removes
/// exactly the window volume. Pre-fix the tilted cut fragmented at "unlucky"
/// angles and over-cut throughout the ~18° band.
#[test]
fn rotated_opening_cuts_clean_at_every_angle() {
    for angle in [3.0, 8.0, 15.0, 20.0, 33.0, 45.0] {
        for tessellated in [false, true] {
            let (uncut, voided) = cut(&rotated_wall_with_window_ifc(angle, tessellated));
            let removed = mesh_volume(&uncut) - mesh_volume(&voided);
            assert!(
                (removed - WINDOW_VOLUME).abs() < 0.04,
                "angle {angle}° tess={tessellated}: removed {removed:.5} m³, expected {WINDOW_VOLUME:.5}"
            );
            let (open_edges, needles) = defects(&voided);
            assert_eq!(
                open_edges, 0,
                "angle {angle}° tess={tessellated}: {open_edges} unpaired edges — the rotated cut fragmented (issue #1167)"
            );
            assert_eq!(
                needles, 0,
                "angle {angle}° tess={tessellated}: {needles} sliver/needle triangles (issue #1167)"
            );
        }
    }
}
