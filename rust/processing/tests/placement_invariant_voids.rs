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

/// The voided hosts of one run, by express id, with vertices in world
/// coordinates (the mesh frame undone in f64).
fn hosts(result: &ProcessingResult) -> Vec<(u32, &MeshData, Vec<[f64; 3]>)> {
    let to_world = result.frame.world_mapper();
    let mut hosts: Vec<_> = result
        .meshes
        .iter()
        .filter(|mesh| [50, 90, 130].contains(&mesh.express_id))
        .map(|mesh| {
            let world = mesh
                .positions
                .chunks_exact(3)
                .map(|p| to_world([0, 1, 2].map(|k| p[k] as f64 + mesh.origin[k])))
                .collect();
            (mesh.express_id, mesh, world)
        })
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

#[test]
fn voided_hosts_mesh_the_same_wherever_the_site_is() {
    let request = ProcessingRequest::full_pass();
    let unplaced = process(fixture([0.0; 3], 0.0).as_bytes(), &request, &mut ());
    let placed = process(fixture(SITE_AT, SITE_YAW_DEG).as_bytes(), &request, &mut ());
    let (at_origin, moved) = (hosts(&unplaced), hosts(&placed));
    assert_eq!(at_origin.len(), 3, "two walls and a slab at the origin");
    assert_eq!(moved.len(), 3, "two walls and a slab under the moved site");

    for ((id, origin_mesh, origin_world), (_, moved_mesh, moved_world)) in at_origin.iter().zip(&moved) {
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
        let worst = origin_world
            .iter()
            .zip(moved_world)
            .map(|(a, b)| {
                let b = into_site(*b);
                ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt()
            })
            .fold(0.0, f64::max);
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

/// Undirected edges not used exactly once in each direction, keyed on a
/// 1 um grid, and the enclosed volume (m3).
fn closure_and_volume(world: &[[f64; 3]], indices: &[u32]) -> (usize, f64) {
    use std::collections::HashMap;
    let key = |p: [f64; 3]| p.map(|c| (c * 1.0e6).round() as i64);
    let mut edges: HashMap<([i64; 3], [i64; 3]), i64> = HashMap::new();
    let mut volume = 0.0;
    for t in indices.chunks_exact(3) {
        let [a, b, c] = [0, 1, 2].map(|k| world[t[k] as usize]);
        volume += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0])
            + a[2] * (b[0] * c[1] - b[1] * c[0]))
            / 6.0;
        for (p, q) in [(a, b), (b, c), (c, a)] {
            let (p, q) = (key(p), key(q));
            if p != q {
                let (lo, hi, s) = if p < q { (p, q, 1) } else { (q, p, -1) };
                *edges.entry((lo, hi)).or_insert(0) += s;
            }
        }
    }
    (edges.values().filter(|&&n| n != 0).count(), volume)
}

/// A host and an opening placed absolutely, each the root of its own chain,
/// cut the same at the origin and under a rotated, translated placement, and
/// closed with the expected volume both times: 5 x 0.2 x 3 m less the
/// 1 x 0.2 x 1.2 m the opening takes, to the census bless bound.
#[test]
fn absolutely_placed_host_and_opening_mesh_the_same_wherever_they_are() {
    let request = ProcessingRequest::full_pass();
    let unplaced = process(absolute_fixture([0.0; 3], 0.0).as_bytes(), &request, &mut ());
    let placed = process(absolute_fixture(SITE_AT, SITE_YAW_DEG).as_bytes(), &request, &mut ());
    let wall = |result: &ProcessingResult| {
        let to_world = result.frame.world_mapper();
        let mesh = result.meshes.iter().find(|mesh| mesh.express_id == 50).expect("the wall is meshed").clone();
        let world: Vec<[f64; 3]> = mesh
            .positions
            .chunks_exact(3)
            .map(|p| to_world([0, 1, 2].map(|k| p[k] as f64 + mesh.origin[k])))
            .collect();
        (mesh, world)
    };
    let ((origin_mesh, origin_world), (moved_mesh, moved_world)) = (wall(&unplaced), wall(&placed));
    for (label, mesh, world) in [("origin", &origin_mesh, &origin_world), ("moved", &moved_mesh, &moved_world)] {
        let (open, volume) = closure_and_volume(world, &mesh.indices);
        assert_eq!(open, 0, "{label}: the cut wall is not closed");
        // The census bless bound: within 0.05% of the exact volume.
        assert!((volume - 2.76).abs() <= 2.76 * 5.0e-4, "{label}: volume {volume:.9} m3, expected 2.76");
    }
    assert_eq!(moved_mesh.indices, origin_mesh.indices, "index buffer changed with the placement");
    let worst = origin_world
        .iter()
        .zip(&moved_world)
        .map(|(a, b)| {
            let b = into_site(*b);
            ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2) + (a[2] - b[2]).powi(2)).sqrt()
        })
        .fold(0.0, f64::max);
    assert!(worst <= TOLERANCE_M, "a vertex moved {worst:.3e} m with the placement (tolerance {TOLERANCE_M:.1e} m)");
}
