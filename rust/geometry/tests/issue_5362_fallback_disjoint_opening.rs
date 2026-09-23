// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Regression for #5362: the #635 AABB fallback box-cut a host that the
//! opening does not reach, and left it open.
//!
//! A 6 x 0.3 x 3 m `IfcPolygonalFaceSet` wall carries a 0.2 x 2.0 m extruded
//! opening that ends exactly flush on the wall face without entering it. The
//! wall is rotated 90 degrees about Z. At 31 m from the origin the kernel
//! imprints the contact and the wall stays closed; at 33 m f32 rounding
//! separates the two boxes, the kernel reports `NoBoundsOverlap`, and the
//! fallback used to remove the wall's face strip under the opening's bounding
//! box and leave 20 open edges. Nothing should be removed either way.

use ifc_lite_core::{build_entity_index, EntityDecoder};
use ifc_lite_geometry::{GeometryRouter, Mesh};
use rustc_hash::FxHashMap;
use std::collections::HashMap;

const WALL: u32 = 33;
const OPENING: u32 = 49;

const FLUSH_OPENING: &str = r##"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ViewDefinition [CoordinationView]'),'2;1');
FILE_NAME('','2026-01-01T00:00:00',(''),(''),'test','test','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#2=IFCUNITASSIGNMENT((#1));
#3=IFCCARTESIANPOINT((0.,0.,0.));
#4=IFCAXIS2PLACEMENT3D(#3,$,$);
#5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#4,$);
#6=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#5,$,.MODEL_VIEW.,$);
#7=IFCPROJECT('1EF5ASC0T3k8e0caN3fbs0',$,'p',$,$,$,$,(#5),#2);
#8=IFCDIRECTION((0.,0.,1.));
#9=IFCDIRECTION((1.,0.,0.));
#10=IFCDIRECTION((0.,1.,0.));
#12=IFCCARTESIANPOINT((OFFSET,0.,0.));
#13=IFCAXIS2PLACEMENT3D(#12,#8,#10);
#11=IFCLOCALPLACEMENT($,#13);
#20=IFCCARTESIANPOINTLIST3D(((0.0,-0.15,0.0),(6.0,-0.15,0.0),(6.0,-0.15,3.0),(0.0,-0.15,3.0),(0.0,0.15,0.0),(0.0,0.15,3.0),(6.0,0.15,3.0),(6.0,0.15,0.0)));
#21=IFCINDEXEDPOLYGONALFACE((1,2,3,4));
#22=IFCINDEXEDPOLYGONALFACE((5,6,7,8));
#23=IFCINDEXEDPOLYGONALFACE((2,1,5,8));
#24=IFCINDEXEDPOLYGONALFACE((4,3,7,6));
#25=IFCINDEXEDPOLYGONALFACE((3,2,8,7));
#26=IFCINDEXEDPOLYGONALFACE((1,4,6,5));
#30=IFCPOLYGONALFACESET(#20,.T.,(#21,#22,#23,#24,#25,#26),$);
#31=IFCSHAPEREPRESENTATION(#6,'Body','Tessellation',(#30));
#32=IFCPRODUCTDEFINITIONSHAPE($,$,(#31));
#33=IFCWALL('1O9vPAhrD9_ghFHXA3Oje9',$,'wall',$,$,#11,#32,$,$);
#40=IFCCARTESIANPOINTLIST2D(((-0.1,-1.0),(0.1,-1.0),(0.1,1.0),(-0.1,1.0),(-0.1,-1.0)));
#41=IFCINDEXEDPOLYCURVE(#40,$,.F.);
#42=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#41);
#43=IFCCARTESIANPOINT((3.0,-2.0,1.0));
#44=IFCAXIS2PLACEMENT3D(#43,#10,#9);
#45=IFCEXTRUDEDAREASOLID(#42,#44,#8,1.85);
#46=IFCSHAPEREPRESENTATION(#6,'Body','SweptSolid',(#45));
#47=IFCPRODUCTDEFINITIONSHAPE($,$,(#46));
#48=IFCLOCALPLACEMENT(#11,#4);
#49=IFCOPENINGELEMENT('1YlYgHWXLASeyVaJUnnYGl',$,'opening',$,$,#48,#47,$,.OPENING.);
#50=IFCRELVOIDSELEMENT('1R_djD_uXEC9K3uPiPLVvG',$,$,$,#33,#49);
ENDSEC;
END-ISO-10303-21;"##;

fn open_edges(m: &Mesh) -> usize {
    let key = |i: u32| {
        let b = i as usize * 3;
        [0, 1, 2].map(|k| ((m.positions[b + k] as f64 + m.origin[k]) * 1.0e5).round() as i64)
    };
    let mut edges: HashMap<_, u32> = HashMap::new();
    for t in m.indices.chunks_exact(3) {
        let k = [key(t[0]), key(t[1]), key(t[2])];
        if k[0] == k[1] || k[1] == k[2] || k[0] == k[2] {
            continue;
        }
        for (a, b) in [(k[0], k[1]), (k[1], k[2]), (k[2], k[0])] {
            *edges.entry(if a < b { (a, b) } else { (b, a) }).or_insert(0) += 1;
        }
    }
    edges.values().filter(|&&c| c != 2).count()
}

fn volume(m: &Mesh) -> f64 {
    let p = |i: u32| {
        let b = i as usize * 3;
        [0, 1, 2].map(|k| m.positions[b + k] as f64)
    };
    m.indices
        .chunks_exact(3)
        .map(|t| {
            let (a, b, c) = (p(t[0]), p(t[1]), p(t[2]));
            (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0])
                + a[2] * (b[0] * c[1] - b[1] * c[0]))
                / 6.0
        })
        .sum::<f64>()
        .abs()
}

fn wall_with_voids(offset: &str) -> Mesh {
    let content = FLUSH_OPENING.replace("OFFSET", offset);
    let index = build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, index);
    let mut voids: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    voids.insert(WALL, vec![OPENING]);
    let wall = decoder.decode_by_id(WALL).expect("decode wall");
    GeometryRouter::new()
        .process_element_with_voids(&wall, &mut decoder, &voids)
        .expect("wall must process")
}

#[test]
fn a_flush_opening_that_does_not_reach_the_wall_removes_nothing() {
    for offset in ["31.", "33."] {
        let mesh = wall_with_voids(offset);
        assert_eq!(open_edges(&mesh), 0, "wall at x = {offset} m must stay closed (20 open edges at 33 m before #5362)");
        let v = volume(&mesh);
        assert!((v - 5.4).abs() < 5.4e-3, "wall at x = {offset} m must keep its full 5.4 m3 (f32 at 30 m reads within 0.1%), got {v}");
    }
}
