// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Thin host material next to a void cut: the skin behind a recess that
//! stops short of the far face, and the triangles of a thin sheet.
//!
//! A recess ending under 1 mm from the far face used to be pushed through:
//! a 12 mm sheet with an 11.2 mm recess lost its 0.8 mm skin. Three rules
//! each did it, and the skin survives only with all three right:
//!
//! - the prism cap extension took host material within 1 mm beyond a cap for
//!   a face lying on the cap (`prism_cut/extension.rs`),
//! - the recess test of the rectangle paths compared the opening with host
//!   bounds the facet weld had rounded to the kernel grid, 5.8 um off a face
//!   the recess starts on, against a 4 um tolerance (`voids/flush.rs`),
//! - the exit-cap probe looked for host material from 4 mm beyond a cap
//!   (`synthesis/exit_cap.rs`).
//!
//! The hand-written fixture is one faceted sheet with a box recess, as an
//! exporter writes a finish layer, meshed with the site axis-aligned and
//! rotated in plan. It takes the prism cut and shows the first rule. The
//! other two need a host the facet weld moves: `fixtures/
//! thin_skin_recess_rvt01_14638.ifc` is wall #14638 of `tests/models/various/
//! rvt01.ifc` with its three openings, cut out by `scripts/
//! ifc-extract-hosts.py --anonymise` with the site placement set to identity.
//! Its second finish layer is 12 mm thick. The exporter wrote the recess twice:
//! as a notch in the layer's own profile, 11 mm deep and 19.2 mm wide at one
//! end, and as an `IfcOpeningElement` over the same place. The opening was
//! pushed through the 1 mm the notch leaves.

use ifc_lite_processing::{process, MeshData, ProcessingRequest};
use ifc_lite_testkit::mesh::{signed_volume, triangle_shape};

const HOST: u32 = 50;

/// One wall under a site at the origin, yawed `yaw_deg` about Z. `host` is the
/// wall's `(length, thickness, height)`: a faceted box with one corner at the
/// wall placement, as an exporter writes a finish layer or a clipped wall.
/// Each opening is `(x0, x1, z0, z1, depth)`: a box entering the wall through
/// its y = 0 face.
fn fixture(yaw_deg: f64, host: [f64; 3], openings: &[[f64; 5]]) -> String {
    let (sin, cos) = yaw_deg.to_radians().sin_cos();
    let [length, thickness, height] = host;
    let mut data = format!(
        "ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');
FILE_NAME('void-cut-thin-remainder.ifc','2026-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0ThinRemainder0000001',$,'Project',$,$,$,$,(#10),#5);
#2=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#3=IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.);
#5=IFCUNITASSIGNMENT((#2,#3));
#6=IFCCARTESIANPOINT((0.,0.,0.));
#7=IFCDIRECTION((0.,0.,1.));
#8=IFCDIRECTION((1.,0.,0.));
#9=IFCAXIS2PLACEMENT3D(#6,#7,#8);
#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#9,$);
#11=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#10,$,.MODEL_VIEW.,$);
#12=IFCDIRECTION((1.,0.));
#13=IFCDIRECTION((0.,1.,0.));
#20=IFCCARTESIANPOINT((0.,0.,0.));
#21=IFCDIRECTION(({cos:?},{sin:?},0.));
#22=IFCAXIS2PLACEMENT3D(#20,#7,#21);
#23=IFCLOCALPLACEMENT($,#22);
#24=IFCSITE('0ThinRemainder0000002',$,'Site',$,$,#23,$,$,.ELEMENT.,$,$,$,$,$);
#25=IFCLOCALPLACEMENT(#23,#9);
#26=IFCBUILDING('0ThinRemainder0000003',$,'Building',$,$,#25,$,$,.ELEMENT.,$,$,$);
#29=IFCLOCALPLACEMENT(#25,#9);
#30=IFCBUILDINGSTOREY('0ThinRemainder0000004',$,'Storey',$,$,#29,$,$,.ELEMENT.,0.);
#31=IFCRELAGGREGATES('0ThinRemainder0000005',$,$,$,#1,(#24));
#32=IFCRELAGGREGATES('0ThinRemainder0000006',$,$,$,#24,(#26));
#33=IFCRELAGGREGATES('0ThinRemainder0000007',$,$,$,#26,(#30));
#34=IFCRELCONTAINEDINSPATIALSTRUCTURE('0ThinRemainder0000008',$,$,$,(#{HOST}),#30);
#42=IFCLOCALPLACEMENT(#29,#9);
#60=IFCCARTESIANPOINT((0.,0.,0.));
#61=IFCCARTESIANPOINT(({length:?},0.,0.));
#62=IFCCARTESIANPOINT(({length:?},{thickness:?},0.));
#63=IFCCARTESIANPOINT((0.,{thickness:?},0.));
#64=IFCCARTESIANPOINT((0.,0.,{height:?}));
#65=IFCCARTESIANPOINT(({length:?},0.,{height:?}));
#66=IFCCARTESIANPOINT(({length:?},{thickness:?},{height:?}));
#67=IFCCARTESIANPOINT((0.,{thickness:?},{height:?}));
#70=IFCPOLYLOOP((#60,#63,#62,#61));
#71=IFCPOLYLOOP((#64,#65,#66,#67));
#72=IFCPOLYLOOP((#60,#61,#65,#64));
#73=IFCPOLYLOOP((#61,#62,#66,#65));
#74=IFCPOLYLOOP((#62,#63,#67,#66));
#75=IFCPOLYLOOP((#63,#60,#64,#67));
#76=IFCFACEOUTERBOUND(#70,.T.);
#77=IFCFACEOUTERBOUND(#71,.T.);
#78=IFCFACEOUTERBOUND(#72,.T.);
#79=IFCFACEOUTERBOUND(#73,.T.);
#80=IFCFACEOUTERBOUND(#74,.T.);
#81=IFCFACEOUTERBOUND(#75,.T.);
#82=IFCFACE((#76));
#83=IFCFACE((#77));
#84=IFCFACE((#78));
#85=IFCFACE((#79));
#86=IFCFACE((#80));
#87=IFCFACE((#81));
#88=IFCCLOSEDSHELL((#82,#83,#84,#85,#86,#87));
#46=IFCFACETEDBREP(#88);
#47=IFCSHAPEREPRESENTATION(#11,'Body','Brep',(#46));
#48=IFCPRODUCTDEFINITIONSHAPE($,$,(#47));
#{HOST}=IFCWALL('0ThinRemainder0000009',$,'Wall',$,$,#42,#48,$,$);
"
    );
    for (k, [x0, x1, z0, z1, depth]) in openings.iter().enumerate() {
        let id = 100 + 20 * k;
        let (width, rise) = (x1 - x0, z1 - z0);
        // The opening's Z is the wall's +Y, so its profile Y is the wall's -Z.
        data.push_str(&format!(
            "#{p}=IFCCARTESIANPOINT(({x0:?},0.,{z0:?}));
#{a}=IFCAXIS2PLACEMENT3D(#{p},#13,#8);
#{l}=IFCLOCALPLACEMENT(#42,#{a});
#{c}=IFCCARTESIANPOINT(({cx:?},{cy:?}));
#{c2}=IFCAXIS2PLACEMENT2D(#{c},#12);
#{r}=IFCRECTANGLEPROFILEDEF(.AREA.,$,#{c2},{width:?},{rise:?});
#{e}=IFCEXTRUDEDAREASOLID(#{r},#9,#7,{depth:?});
#{s}=IFCSHAPEREPRESENTATION(#11,'Body','SweptSolid',(#{e}));
#{d}=IFCPRODUCTDEFINITIONSHAPE($,$,(#{s}));
#{o}=IFCOPENINGELEMENT('0ThinRemainderOpen{k:04}',$,'Opening',$,$,#{l},#{d},$,.OPENING.);
#{v}=IFCRELVOIDSELEMENT('0ThinRemainderVoid{k:04}',$,$,$,#{HOST},#{o});
",
            p = id,
            a = id + 1,
            l = id + 2,
            c = id + 3,
            c2 = id + 4,
            r = id + 5,
            e = id + 6,
            s = id + 7,
            d = id + 8,
            o = id + 9,
            v = id + 10,
            cx = width / 2.0,
            cy = -rise / 2.0,
        ));
    }
    data.push_str("ENDSEC;\nEND-ISO-10303-21;\n");
    data
}

/// Surface area of a mesh, read in f64.
fn surface_area(mesh: &MeshData) -> f64 {
    let point = |i: u32| [0, 1, 2].map(|k| f64::from(mesh.positions[i as usize * 3 + k]));
    mesh.indices
        .chunks_exact(3)
        .map(|t| {
            let [a, b, c] = [point(t[0]), point(t[1]), point(t[2])];
            let (u, v) = ([0, 1, 2].map(|k| b[k] - a[k]), [0, 1, 2].map(|k| c[k] - a[k]));
            let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
            0.5 * (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt()
        })
        .sum()
}

/// Yaws the site is meshed under: axis-aligned, and rotated in plan.
const YAWS_DEG: [f64; 2] = [0.0, 30.0];

/// The 12 mm sheet of the recess cases: 3 m long and 3 m high.
const SHEET: [f64; 3] = [3.0, 0.012, 3.0];

/// [`SHEET`] with a 0.4 m by 1 m recess of each depth, under each yaw: the
/// cuts whose volume is more than 0.05% off.
fn volume_mismatches(depths: &[f64]) -> Vec<String> {
    let mut wrong = Vec::new();
    for &depth in depths {
        let expected = SHEET[0] * SHEET[1] * SHEET[2] - 0.4 * 1.0 * depth;
        for yaw in YAWS_DEG {
            let ifc = fixture(yaw, SHEET, &[[1.3, 1.7, 1.0, 2.0, depth]]);
            let result = process(ifc.as_bytes(), &ProcessingRequest::full_pass(), &mut ());
            let hosts: Vec<&MeshData> = result.meshes.iter().filter(|mesh| mesh.express_id == HOST).collect();
            assert_eq!(hosts.len(), 1, "the wall meshes as one body");
            let volume = signed_volume(&hosts[0].positions, &hosts[0].indices).abs();
            if (volume - expected).abs() > 5.0e-4 * expected {
                let mm = depth * 1000.0;
                wrong.push(format!("{mm} mm recess, site yaw {yaw} deg: {volume:.6} m3, expected {expected:.6}"));
            }
        }
    }
    wrong
}

#[test]
fn a_recess_keeps_a_skin_of_two_millimetres_or_more() {
    let wrong = volume_mismatches(&[0.006, 0.010]);
    assert!(wrong.is_empty(), "{wrong:#?}");
}

/// Without the fix: 0.103200 m3 for the 11.2 and 11.8 mm recesses at both
/// yaws and for the 11 mm one at 30 degrees, the sheet cut through.
#[test]
fn a_recess_keeps_a_skin_thinner_than_a_millimetre() {
    let wrong = volume_mismatches(&[0.011, 0.0112, 0.0118]);
    assert!(wrong.is_empty(), "{wrong:#?}");
}

/// Triangles, slivers and worst aspect of the cut host, by the mesh census's
/// measure.
fn shape_census(ifc: &str) -> (usize, usize, f64) {
    let result = process(ifc.as_bytes(), &ProcessingRequest::full_pass(), &mut ());
    let mesh = result.meshes.iter().find(|mesh| mesh.express_id == HOST).expect("the wall meshes");
    let shape = triangle_shape(&mesh.positions, &mesh.indices);
    (mesh.indices.len() / 3, shape.slivers, shape.max_aspect)
}

/// A 0.4 m by 1 m opening through the 12 mm sheet. The sheet's four narrow
/// faces are 250:1 whatever triangulates them, and the reveal adds four more
/// slivers: 12 in 32 triangles, which is also what the parametric rectangle
/// cut gives. The sliver refinement used to bisect those needles and return
/// 80 triangles with 40 slivers, the worst at 375:1, in both frames.
#[test]
fn a_thin_sheet_cut_through_keeps_its_own_triangles() {
    for yaw in YAWS_DEG {
        let (triangles, slivers, worst) =
            shape_census(&fixture(yaw, SHEET, &[[1.3, 1.7, 1.0, 2.0, SHEET[1]]]));
        assert_eq!((triangles, slivers), (32, 12), "site yaw {yaw} deg, worst aspect {worst:.1}");
        assert!(worst < 251.0, "site yaw {yaw} deg: worst aspect {worst:.1}, the sheet's own is 250");
    }
}

/// The Revit wall: two 12 mm finish layers and a 250 mm core. IfcOpenShell
/// 0.8.2 cuts the wall to 45.1495 m2 of surface and 1.778319 m3. Without the
/// fix the layer with the recess comes back 13.1168 m2: the 1 mm skin, 19.2 mm
/// by 3.65 m, is gone with both of its faces (0.140 m2) and its 70 cm3. Each
/// of the three rules in the module doc loses it alone. The volume bound is
/// 30 cm3, so a skin left 2 mm thick (70 cm3 over) fails as well.
#[test]
fn a_finish_layer_keeps_the_skin_behind_an_11_mm_recess() {
    let ifc = include_str!("fixtures/thin_skin_recess_rvt01_14638.ifc");
    let result = process(ifc.as_bytes(), &ProcessingRequest::full_pass(), &mut ());
    let layers: Vec<&MeshData> = result.meshes.iter().filter(|mesh| mesh.express_id == 14638).collect();
    let mut areas: Vec<f64> = layers.iter().map(|mesh| surface_area(mesh)).collect();
    areas.sort_by(f64::total_cmp);
    let expected = [13.2569, 13.2570, 18.6354];
    assert_eq!(areas.len(), expected.len(), "one mesh per layer: {areas:?}");
    for (area, want) in areas.iter().zip(expected) {
        assert!((area - want).abs() < 0.01, "layer of {area:.4} m2, expected {want:.4}: {areas:?}");
    }
    let total: f64 = areas.iter().sum();
    assert!((total - 45.1495).abs() < 0.01, "wall surface {total:.4} m2, IfcOpenShell 45.1495");
    let volume: f64 = layers.iter().map(|mesh| signed_volume(&mesh.positions, &mesh.indices).abs()).sum();
    assert!((volume - 1.778319).abs() < 3.0e-5, "wall volume {volume:.6} m3, IfcOpenShell 1.778319");
}
