// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! A voided host's mesh must not depend on where the model sits.
//!
//! The fixture is one storey with two walls and a slab, each cut by one
//! opening. It is meshed twice: with its `IfcSite` at the origin, and with
//! the site translated and rotated 30 degrees about Z. Moving the placed
//! result back by the site placement must give the unplaced one: the same
//! triangles, the same vertices, the same index buffer.
//!
//! Before the host-frame cut the opening classification and the strategy
//! chain read world axis alignment, so the rotated copy took a different cut
//! and came back with a different triangulation.

use ifc_lite_processing::{process, MeshData, ProcessingRequest, ProcessingResult};
use ifc_lite_testkit::mesh::{open_edges, signed_volume, Key};

/// Site placement of the moved copy: metres, and the yaw about Z.
const SITE_AT: [f64; 3] = [31.25, -47.5, 12.0];
const SITE_YAW_DEG: f64 = 30.0;

/// The moved copy's vertices are rounded to f32 at world magnitude before
/// they are moved back. The farthest fixture vertex is under 64 m from the
/// origin, where one f32 step is 3.8 um; this allows a few of them.
const TOLERANCE_M: f64 = 2.0e-5;

/// Wall A runs along the site X axis and its opening is placed relative to
/// the wall. Wall B runs along the site Y axis and its opening is placed
/// relative to the storey, so the two placements only share an ancestor. The
/// slab's opening is a vertical cut.
fn fixture(site_at: [f64; 3], site_yaw_deg: f64) -> String {
    let (sin, cos) = site_yaw_deg.to_radians().sin_cos();
    let [sx, sy, sz] = site_at;
    format!(
        "ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');
FILE_NAME('placement-invariant-voids.ifc','2026-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0PlacementInvariant001',$,'Project',$,$,$,$,(#10),#5);
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
#14=IFCDIRECTION((-1.,0.,0.));
#20=IFCCARTESIANPOINT(({sx:?},{sy:?},{sz:?}));
#21=IFCDIRECTION(({cos:?},{sin:?},0.));
#22=IFCAXIS2PLACEMENT3D(#20,#7,#21);
#23=IFCLOCALPLACEMENT($,#22);
#24=IFCSITE('0PlacementInvariant002',$,'Site',$,$,#23,$,$,.ELEMENT.,$,$,$,$,$);
#25=IFCLOCALPLACEMENT(#23,#9);
#26=IFCBUILDING('0PlacementInvariant003',$,'Building',$,$,#25,$,$,.ELEMENT.,$,$,$);
#27=IFCCARTESIANPOINT((0.,0.,3.));
#28=IFCAXIS2PLACEMENT3D(#27,#7,#8);
#29=IFCLOCALPLACEMENT(#25,#28);
#30=IFCBUILDINGSTOREY('0PlacementInvariant004',$,'Storey',$,$,#29,$,$,.ELEMENT.,3.);
#31=IFCRELAGGREGATES('0PlacementInvariant005',$,$,$,#1,(#24));
#32=IFCRELAGGREGATES('0PlacementInvariant006',$,$,$,#24,(#26));
#33=IFCRELAGGREGATES('0PlacementInvariant007',$,$,$,#26,(#30));
#34=IFCRELCONTAINEDINSPATIALSTRUCTURE('0PlacementInvariant008',$,$,$,(#50,#90,#130),#30);
#40=IFCCARTESIANPOINT((2.,3.,0.));
#41=IFCAXIS2PLACEMENT3D(#40,#7,#8);
#42=IFCLOCALPLACEMENT(#29,#41);
#43=IFCCARTESIANPOINT((2.5,0.1));
#44=IFCAXIS2PLACEMENT2D(#43,#12);
#45=IFCRECTANGLEPROFILEDEF(.AREA.,$,#44,5.,0.2);
#46=IFCEXTRUDEDAREASOLID(#45,#9,#7,3.);
#51=IFCCARTESIANPOINT((0.,0.,2.5));
#52=IFCDIRECTION((-0.2,0.,0.98));
#53=IFCDIRECTION((0.98,0.,0.2));
#54=IFCAXIS2PLACEMENT3D(#51,#52,#53);
#55=IFCPLANE(#54);
#56=IFCHALFSPACESOLID(#55,.F.);
#57=IFCBOOLEANCLIPPINGRESULT(.DIFFERENCE.,#46,#56);
#47=IFCSHAPEREPRESENTATION(#11,'Body','Clipping',(#57));
#48=IFCPRODUCTDEFINITIONSHAPE($,$,(#47));
#50=IFCWALL('0PlacementInvariant009',$,'Wall A',$,$,#42,#48,$,$);
#60=IFCCARTESIANPOINT((1.5,-0.05,1.));
#61=IFCAXIS2PLACEMENT3D(#60,#13,#8);
#62=IFCLOCALPLACEMENT(#42,#61);
#63=IFCCARTESIANPOINT((0.5,-0.6));
#64=IFCAXIS2PLACEMENT2D(#63,#12);
#65=IFCRECTANGLEPROFILEDEF(.AREA.,$,#64,1.,1.2);
#66=IFCEXTRUDEDAREASOLID(#65,#9,#7,0.3);
#67=IFCSHAPEREPRESENTATION(#11,'Body','SweptSolid',(#66));
#68=IFCPRODUCTDEFINITIONSHAPE($,$,(#67));
#70=IFCOPENINGELEMENT('0PlacementInvariant010',$,'Opening A',$,$,#62,#68,$,.OPENING.);
#71=IFCRELVOIDSELEMENT('0PlacementInvariant011',$,$,$,#50,#70);
#80=IFCCARTESIANPOINT((10.,3.,0.));
#81=IFCAXIS2PLACEMENT3D(#80,#7,#13);
#82=IFCLOCALPLACEMENT(#29,#81);
#83=IFCEXTRUDEDAREASOLID(#45,#9,#7,3.);
#84=IFCSHAPEREPRESENTATION(#11,'Body','SweptSolid',(#83));
#85=IFCPRODUCTDEFINITIONSHAPE($,$,(#84));
#90=IFCWALL('0PlacementInvariant012',$,'Wall B',$,$,#82,#85,$,$);
#100=IFCCARTESIANPOINT((10.05,4.5,1.));
#101=IFCAXIS2PLACEMENT3D(#100,#14,#13);
#102=IFCLOCALPLACEMENT(#29,#101);
#103=IFCEXTRUDEDAREASOLID(#65,#9,#7,0.3);
#104=IFCSHAPEREPRESENTATION(#11,'Body','SweptSolid',(#103));
#105=IFCPRODUCTDEFINITIONSHAPE($,$,(#104));
#110=IFCOPENINGELEMENT('0PlacementInvariant013',$,'Opening B',$,$,#102,#105,$,.OPENING.);
#111=IFCRELVOIDSELEMENT('0PlacementInvariant014',$,$,$,#90,#110);
#120=IFCCARTESIANPOINT((0.,8.,0.));
#121=IFCAXIS2PLACEMENT3D(#120,#7,#8);
#122=IFCLOCALPLACEMENT(#29,#121);
#123=IFCCARTESIANPOINT((4.,3.));
#124=IFCAXIS2PLACEMENT2D(#123,#12);
#125=IFCRECTANGLEPROFILEDEF(.AREA.,$,#124,8.,6.);
#126=IFCEXTRUDEDAREASOLID(#125,#9,#7,0.3);
#152=IFCCARTESIANPOINT((7.5,5.5));
#153=IFCAXIS2PLACEMENT2D(#152,#12);
#154=IFCRECTANGLEPROFILEDEF(.AREA.,$,#153,1.,1.);
#155=IFCCARTESIANPOINT((0.,0.,-0.1));
#156=IFCAXIS2PLACEMENT3D(#155,#7,#8);
#157=IFCEXTRUDEDAREASOLID(#154,#156,#7,0.5);
#158=IFCBOOLEANRESULT(.DIFFERENCE.,#126,#157);
#127=IFCSHAPEREPRESENTATION(#11,'Body','CSG',(#158));
#128=IFCPRODUCTDEFINITIONSHAPE($,$,(#127));
#130=IFCSLAB('0PlacementInvariant015',$,'Slab',$,$,#122,#128,$,.FLOOR.);
#140=IFCCARTESIANPOINT((3.,2.,-0.05));
#141=IFCAXIS2PLACEMENT3D(#140,#7,#8);
#142=IFCLOCALPLACEMENT(#122,#141);
#143=IFCCARTESIANPOINT((0.75,0.5));
#144=IFCAXIS2PLACEMENT2D(#143,#12);
#145=IFCRECTANGLEPROFILEDEF(.AREA.,$,#144,1.5,1.);
#146=IFCEXTRUDEDAREASOLID(#145,#9,#7,0.4);
#147=IFCSHAPEREPRESENTATION(#11,'Body','SweptSolid',(#146));
#148=IFCPRODUCTDEFINITIONSHAPE($,$,(#147));
#150=IFCOPENINGELEMENT('0PlacementInvariant016',$,'Opening C',$,$,#142,#148,$,.OPENING.);
#151=IFCRELVOIDSELEMENT('0PlacementInvariant017',$,$,$,#130,#150);
ENDSEC;
END-ISO-10303-21;
"
    )
}

/// `mesh`'s vertices in world coordinates (the mesh frame undone in f64).
fn world_vertices(result: &ProcessingResult, mesh: &MeshData) -> Vec<[f64; 3]> {
    let to_world = result.frame.world_mapper();
    mesh.positions.chunks_exact(3).map(|p| to_world([0, 1, 2].map(|k| p[k] as f64 + mesh.origin[k]))).collect()
}

/// The voided hosts of one run, by express id, with world vertices.
fn hosts(result: &ProcessingResult) -> Vec<(u32, &MeshData, Vec<[f64; 3]>)> {
    let mut hosts: Vec<_> = result
        .meshes
        .iter()
        .filter(|mesh| [50, 90, 130].contains(&mesh.express_id))
        .map(|mesh| (mesh.express_id, mesh, world_vertices(result, mesh)))
        .collect();
    hosts.sort_by_key(|(id, ..)| *id);
    hosts
}

/// `p` in the frame of the moved site: the inverse of the site placement.
fn into_site(p: [f64; 3]) -> [f64; 3] {
    let (sin, cos) = SITE_YAW_DEG.to_radians().sin_cos();
    let d = [p[0] - SITE_AT[0], p[1] - SITE_AT[1], p[2] - SITE_AT[2]];
    [cos * d[0] + sin * d[1], -sin * d[0] + cos * d[1], d[2]]
}

/// The object-frame capture (#1474) of `mesh` must hold its vertices:
/// `local_to_world` applied to `local_bounds` bounds every world vertex.
/// `required` refuses a mesh without one; otherwise it is skipped.
fn assert_capture_holds(label: &str, mesh: &MeshData, world: &[[f64; 3]], required: bool) {
    let (Some(b), Some(m)) = (mesh.local_bounds, mesh.local_to_world) else {
        assert!(!required, "{label}: the object-frame capture is missing");
        return;
    };
    let (mut lo, mut hi) = ([f64::INFINITY; 3], [f64::NEG_INFINITY; 3]);
    for corner in 0..8 {
        let p = [0, 1, 2].map(|k| b[if corner >> k & 1 == 0 { k } else { k + 3 }] as f64);
        for r in 0..3 {
            let v = m[r * 4] * p[0] + m[r * 4 + 1] * p[1] + m[r * 4 + 2] * p[2] + m[r * 4 + 3];
            lo[r] = lo[r].min(v);
            hi[r] = hi[r].max(v);
        }
    }
    for v in world {
        assert!(
            (0..3).all(|r| v[r] >= lo[r] - 1.0e-4 && v[r] <= hi[r] + 1.0e-4),
            "{label}: vertex {v:?} lies outside the captured object-frame box {lo:?}..{hi:?}"
        );
    }
}

/// The largest distance between a vertex at the origin and its moved
/// counterpart taken back into the site frame.
fn worst_deviation(at_origin: &[[f64; 3]], moved: &[[f64; 3]]) -> f64 {
    at_origin
        .iter()
        .zip(moved)
        .map(|(a, b)| {
            let b = into_site(*b);
            ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt()
        })
        .fold(0.0, f64::max)
}

#[test]
fn voided_hosts_mesh_the_same_wherever_the_site_is() {
    let request = ProcessingRequest::full_pass();
    let unplaced = process(fixture([0.0; 3], 0.0).as_bytes(), &request, &mut ());
    let placed = process(fixture(SITE_AT, SITE_YAW_DEG).as_bytes(), &request, &mut ());
    let (at_origin, moved) = (hosts(&unplaced), hosts(&placed));
    assert_eq!(at_origin.len(), 3, "two walls and a slab at the origin");
    assert_eq!(moved.len(), 3, "two walls and a slab under the moved site");
    // A site that only translates keeps the object-frame capture (#4176), and
    // a host cut in that root frame must carry a capture that holds it.
    let shifted = process(fixture(SITE_AT, 0.0).as_bytes(), &request, &mut ());
    for (id, mesh, world) in hosts(&shifted) {
        assert_capture_holds(&format!("#{id} under a translated site"), mesh, &world, true);
    }
    // The capture is the host's own frame: each wall's whole placement is the
    // site, the storey (z 3) and its own. Wall A sits at (2, 3, 0) along the
    // site X axis; wall B at (10, 3, 0) with its X axis along the site Y axis.
    for (id, at, x_axis) in [(50, [2.0, 3.0], [1.0, 0.0, 0.0]), (90, [10.0, 3.0], [0.0, 1.0, 0.0])] {
        let wall = shifted.meshes.iter().find(|mesh| mesh.express_id == id).expect("the wall is meshed");
        let l2w = wall.local_to_world.expect("the wall carries its placement");
        let origin = [SITE_AT[0] + at[0], SITE_AT[1] + at[1], SITE_AT[2] + 3.0];
        for r in 0..3 {
            assert!((l2w[r * 4 + 3] - origin[r]).abs() < 1.0e-9, "#{id} local_to_world origin: {l2w:?}");
            assert!((l2w[r * 4] - x_axis[r]).abs() < 1.0e-12, "#{id} local_to_world X axis: {l2w:?}");
        }
        // Bounds in the wall's own frame: its 5 x 0.2 x 3 m extrusion.
        let bounds = wall.local_bounds.expect("the wall carries its bounds");
        for (k, want) in [0.0, 0.0, 0.0, 5.0, 0.2, 3.0].into_iter().enumerate() {
            assert!((bounds[k] as f64 - want).abs() < 1.0e-4, "#{id} local_bounds: {bounds:?}");
        }
    }

    for ((id, origin_mesh, origin_world), (_, moved_mesh, moved_world)) in at_origin.iter().zip(&moved) {
        assert_capture_holds(&format!("#{id} at the origin"), origin_mesh, origin_world, false);
        assert_capture_holds(&format!("#{id} moved"), moved_mesh, moved_world, false);
        // Every opening actually cut its host: a box has 12 triangles.
        assert!(origin_mesh.indices.len() / 3 > 12, "#{id}: the opening was not cut");
        assert_eq!(
            moved_mesh.indices.len() / 3,
            origin_mesh.indices.len() / 3,
            "#{id}: triangle count changed with the site placement"
        );
        assert_eq!(
            moved_world.len(),
            origin_world.len(),
            "#{id}: vertex count changed with the site placement"
        );
        assert_eq!(moved_mesh.indices, origin_mesh.indices, "#{id}: index buffer changed with the site placement");
        let worst = worst_deviation(origin_world, moved_world);
        assert!(
            worst <= TOLERANCE_M,
            "#{id}: a vertex moved {worst:.3e} m with the site placement (tolerance {TOLERANCE_M:.1e} m)"
        );
    }
}

/// One wall and its opening, each placed absolutely (`PlacementRelTo` unset),
/// with the site transform baked into both placements. Each placement is then
/// the root of its own chain, so the host and the opening share no ancestor.
fn absolute_fixture(at: [f64; 3], yaw_deg: f64) -> String {
    let (sin, cos) = yaw_deg.to_radians().sin_cos();
    let rot = |p: [f64; 3]| [at[0] + cos * p[0] - sin * p[1], at[1] + sin * p[0] + cos * p[1], at[2] + p[2]];
    let [wx, wy, wz] = rot([2.0, 3.0, 3.0]);
    let [ox, oy, oz] = rot([3.5, 2.95, 4.0]);
    format!(
        "ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');
FILE_NAME('absolute-placement-voids.ifc','2026-01-01T00:00:00',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0AbsolutePlacement0001',$,'Project',$,$,$,$,(#10),#5);
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
#23=IFCLOCALPLACEMENT($,#9);
#24=IFCSITE('0AbsolutePlacement0002',$,'Site',$,$,#23,$,$,.ELEMENT.,$,$,$,$,$);
#25=IFCBUILDING('0AbsolutePlacement0003',$,'Building',$,$,#23,$,$,.ELEMENT.,$,$,$);
#30=IFCBUILDINGSTOREY('0AbsolutePlacement0004',$,'Storey',$,$,#23,$,$,.ELEMENT.,0.);
#31=IFCRELAGGREGATES('0AbsolutePlacement0005',$,$,$,#1,(#24));
#32=IFCRELAGGREGATES('0AbsolutePlacement0006',$,$,$,#24,(#25));
#33=IFCRELAGGREGATES('0AbsolutePlacement0007',$,$,$,#25,(#30));
#34=IFCRELCONTAINEDINSPATIALSTRUCTURE('0AbsolutePlacement0008',$,$,$,(#50),#30);
#40=IFCCARTESIANPOINT(({wx:?},{wy:?},{wz:?}));
#39=IFCDIRECTION(({cos:?},{sin:?},0.));
#41=IFCAXIS2PLACEMENT3D(#40,#7,#39);
#42=IFCLOCALPLACEMENT($,#41);
#43=IFCCARTESIANPOINT((2.5,0.1));
#44=IFCAXIS2PLACEMENT2D(#43,#12);
#45=IFCRECTANGLEPROFILEDEF(.AREA.,$,#44,5.,0.2);
#46=IFCEXTRUDEDAREASOLID(#45,#9,#7,3.);
#47=IFCSHAPEREPRESENTATION(#11,'Body','SweptSolid',(#46));
#48=IFCPRODUCTDEFINITIONSHAPE($,$,(#47));
#50=IFCWALL('0AbsolutePlacement0009',$,'Wall',$,$,#42,#48,$,$);
#60=IFCCARTESIANPOINT(({ox:?},{oy:?},{oz:?}));
#59=IFCDIRECTION(({nsin:?},{cos:?},0.));
#61=IFCAXIS2PLACEMENT3D(#60,#59,#39);
#62=IFCLOCALPLACEMENT($,#61);
#63=IFCCARTESIANPOINT((0.5,-0.6));
#64=IFCAXIS2PLACEMENT2D(#63,#12);
#65=IFCRECTANGLEPROFILEDEF(.AREA.,$,#64,1.,1.2);
#66=IFCEXTRUDEDAREASOLID(#65,#9,#7,0.3);
#67=IFCSHAPEREPRESENTATION(#11,'Body','SweptSolid',(#66));
#68=IFCPRODUCTDEFINITIONSHAPE($,$,(#67));
#70=IFCOPENINGELEMENT('0AbsolutePlacement0010',$,'Opening',$,$,#62,#68,$,.OPENING.);
#71=IFCRELVOIDSELEMENT('0AbsolutePlacement0011',$,$,$,#50,#70);
ENDSEC;
END-ISO-10303-21;
",
        nsin = -sin
    )
}

/// A host and an opening placed absolutely, each the root of its own chain,
/// which places no site, so the host is cut in the caller's frame as on main.
/// It cuts the same at the origin and under a rotated, translated placement, and
/// closed with the expected volume both times: 5 x 0.2 x 3 m less the
/// 1 x 0.2 x 1.2 m the opening takes, to the census bless bound.
#[test]
fn absolutely_placed_host_and_opening_mesh_the_same_wherever_they_are() {
    let request = ProcessingRequest::full_pass();
    let unplaced = process(absolute_fixture([0.0; 3], 0.0).as_bytes(), &request, &mut ());
    let placed = process(absolute_fixture(SITE_AT, SITE_YAW_DEG).as_bytes(), &request, &mut ());
    let wall = |result: &ProcessingResult| {
        result.meshes.iter().find(|mesh| mesh.express_id == 50).expect("the wall is meshed").clone()
    };
    let (origin_mesh, moved_mesh) = (wall(&unplaced), wall(&placed));
    for (label, mesh) in [("origin", &origin_mesh), ("moved", &moved_mesh)] {
        let open = open_edges(&mesh.positions, &mesh.indices, Key::Grid(1.0e-6));
        let volume = signed_volume(&mesh.positions, &mesh.indices);
        assert_eq!(open, 0, "{label}: the cut wall is not closed");
        // The census bless bound: within 0.05% of the exact volume.
        assert!((volume - 2.76).abs() <= 2.76 * 5.0e-4, "{label}: volume {volume:.9} m3, expected 2.76");
    }
    assert_eq!(moved_mesh.indices, origin_mesh.indices, "index buffer changed with the placement");
    let worst = worst_deviation(&world_vertices(&unplaced, &origin_mesh), &world_vertices(&placed, &moved_mesh));
    assert!(worst <= TOLERANCE_M, "a vertex moved {worst:.3e} m with the placement (tolerance {TOLERANCE_M:.1e} m)");
}

/// `hello-wall.ifc` (the viewer's #7328 sample) with its storey placed
/// absolutely and rotated 90 degrees about Z, and wall #1222 (two openings)
/// placed either in that storey or, `under_b`, in a second storey placed
/// absolutely and rotated 45 degrees, with the relative placement that keeps
/// the wall where it is. The openings stay placed relative to the wall.
fn reparent_fixture(under_b: bool) -> String {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../apps/viewer/public/samples/hello-wall.ifc");
    let source = std::fs::read_to_string(path).expect("hello-wall sample");
    let (a_at, a_yaw) = ([2.0, -3.0, 4.0], 90.0_f64.to_radians());
    let (b_at, b_yaw) = ([-7.0, 6.0, 12.0], 45.0_f64.to_radians());
    let axis = |id: u32, at: [f64; 3], yaw: f64| {
        let (sin, cos) = yaw.sin_cos();
        format!(
            "#{id}=IFCCARTESIANPOINT(({:?},{:?},{:?}));\n#{}=IFCDIRECTION(({cos:?},{sin:?},0.));\n#{}=IFCAXIS2PLACEMENT3D(#{id},#56,#{});\n",
            at[0], at[1], at[2], id + 1, id + 2, id + 1
        )
    };
    // The wall's world frame is storey A's: its own placement is the identity.
    let d = [a_at[0] - b_at[0], a_at[1] - b_at[1], a_at[2] - b_at[2]];
    let (sin, cos) = (-b_yaw).sin_cos();
    let in_b = [cos * d[0] - sin * d[1], sin * d[0] + cos * d[1], d[2]];
    let mut extra = axis(9001, a_at, a_yaw) + &axis(9011, b_at, b_yaw) + "#9014=IFCLOCALPLACEMENT($,#9013);\n";
    let mut text = source.replace("#65=IFCLOCALPLACEMENT(#59,#64);", "#65=IFCLOCALPLACEMENT($,#9003);");
    if under_b {
        extra += &axis(9021, in_b, a_yaw - b_yaw);
        text = text.replace("#1235=IFCLOCALPLACEMENT(#65,#1234);", "#1235=IFCLOCALPLACEMENT(#9014,#9023);");
    }
    assert!(text.contains("#65=IFCLOCALPLACEMENT($,#9003);"), "storey placement rewritten");
    assert_eq!(text.contains("#1235=IFCLOCALPLACEMENT(#9014,#9023);"), under_b, "wall placement rewritten");
    text.replacen("ENDSEC;\nEND-ISO-10303-21;", &format!("{extra}ENDSEC;\nEND-ISO-10303-21;"), 1)
}

/// Viewer #7328 at the Rust level: wall #1222 moved between two absolutely
/// placed, rotated storeys with a relative placement that keeps it where it
/// is meshes the same. The chain roots are storey placements, not a site's,
/// so the wall is cut in the caller's frame both times.
#[test]
fn a_voided_wall_moved_between_absolute_storeys_in_place_meshes_the_same() {
    let request = ProcessingRequest::full_pass();
    let (under_a, under_b) = (
        process(reparent_fixture(false).as_bytes(), &request, &mut ()),
        process(reparent_fixture(true).as_bytes(), &request, &mut ()),
    );
    let walls = |result: &ProcessingResult| -> Vec<MeshData> {
        result.meshes.iter().filter(|mesh| mesh.express_id == 1222).cloned().collect()
    };
    let (a, b) = (walls(&under_a), walls(&under_b));
    assert!(!a.is_empty() && a.len() == b.len(), "wall meshes: {} and {}", a.len(), b.len());
    for (ma, mb) in a.iter().zip(&b) {
        assert_eq!(mb.indices, ma.indices, "index buffer changed with the storey");
        let (wa, wb) = (world_vertices(&under_a, ma), world_vertices(&under_b, mb));
        let worst = wa
            .iter()
            .zip(&wb)
            .map(|(p, q)| ((p[0] - q[0]).powi(2) + (p[1] - q[1]).powi(2) + (p[2] - q[2]).powi(2)).sqrt())
            .fold(0.0, f64::max);
        assert!(worst <= TOLERANCE_M, "a vertex moved {worst:.3e} m with the storey");
    }
}
