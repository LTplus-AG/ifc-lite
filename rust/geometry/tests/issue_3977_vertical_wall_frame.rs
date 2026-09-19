// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! End-to-end regression for #3977. The inline IFC follows the public load
//! path from STEP decoding through opening classification and void routing.

use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner};
use ifc_lite_geometry::{propagate_voids_to_parts, GeometryRouter, Mesh};
use rustc_hash::FxHashMap;

const WALL_ID: u32 = 100;

// A 3-degree plan-rotated, 100 mm wall with a mitred end. Its opening is a
// 13 mm full-height vertical extrusion that trims the miter tip. Cutting this
// directly in the world frame leaves an open 147-triangle mesh; the wall-local
// path introduced for #3977 returns a closed solid.
const IFC: &str = r#"ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('issue-3977 vertical strip'),'2;1');
FILE_NAME('issue_3977.ifc','2026-09-19T00:00:00',(''),(''),'ifc-lite','ifc-lite','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0Issue3977Project000A',$,'Issue 3977',$,$,$,$,(#10),#7);
#7=IFCUNITASSIGNMENT((#8));
#8=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#11,$);
#11=IFCAXIS2PLACEMENT3D(#12,$,$);
#12=IFCCARTESIANPOINT((0.,0.,0.));
#13=IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,#10,$,.MODEL_VIEW.,$);
#14=IFCDIRECTION((0.,0.,1.));
#15=IFCDIRECTION((1.,0.,0.));
#16=IFCAXIS2PLACEMENT3D(#12,#14,#15);
/* Wall placement: rotate the assembly three degrees in plan. */
#20=IFCLOCALPLACEMENT($,#21);
#21=IFCAXIS2PLACEMENT3D(#12,#14,#22);
#22=IFCDIRECTION((0.9986295347545738,0.0523359562429438,0.));
/* Mitred wall footprint, 4 m run x 100 mm thickness x 3 m height. */
#30=IFCCARTESIANPOINT((0.,-0.05));
#31=IFCCARTESIANPOINT((4.,-0.05));
#32=IFCCARTESIANPOINT((3.85,0.05));
#33=IFCCARTESIANPOINT((0.,0.05));
#34=IFCPOLYLINE((#30,#31,#32,#33,#30));
#35=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,'Mitred wall',#34);
#36=IFCEXTRUDEDAREASOLID(#35,#16,#14,3.);
#37=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid',(#36));
#38=IFCPRODUCTDEFINITIONSHAPE($,$,(#37));
#100=IFCWALLSTANDARDCASE('0Issue3977Wall00000A',$,'Mitred wall',$,$,#20,#38,$);
/* Three touching full-height 13 mm strips: x=[3.987,4], y=[-0.05,0.10]. */
#40=IFCCARTESIANPOINT((3.9935,-0.025));
#41=IFCAXIS2PLACEMENT2D(#40,#42);
#42=IFCDIRECTION((1.,0.));
#43=IFCRECTANGLEPROFILEDEF(.AREA.,'Vertical strip 1',#41,0.013,0.05);
#44=IFCEXTRUDEDAREASOLID(#43,#16,#14,3.);
#50=IFCCARTESIANPOINT((3.9935,0.025));
#51=IFCAXIS2PLACEMENT2D(#50,#42);
#53=IFCRECTANGLEPROFILEDEF(.AREA.,'Vertical strip 2',#51,0.013,0.05);
#54=IFCEXTRUDEDAREASOLID(#53,#16,#14,3.);
#60=IFCCARTESIANPOINT((3.9935,0.075));
#61=IFCAXIS2PLACEMENT2D(#60,#42);
#63=IFCRECTANGLEPROFILEDEF(.AREA.,'Vertical strip 3',#61,0.013,0.05);
#64=IFCEXTRUDEDAREASOLID(#63,#16,#14,3.);
#45=IFCSHAPEREPRESENTATION(#13,'Body','SweptSolid',(#44,#54,#64));
#46=IFCPRODUCTDEFINITIONSHAPE($,$,(#45));
#47=IFCLOCALPLACEMENT(#20,#16);
#200=IFCOPENINGELEMENT('0Issue3977Open00000A',$,'Vertical strip',$,$,#47,#46,$,.OPENING.);
#300=IFCRELVOIDSELEMENT('0Issue3977Void00000A',$,$,$,#100,#200);
ENDSEC;
END-ISO-10303-21;
"#;

fn build_void_index(content: &str, decoder: &mut EntityDecoder) -> FxHashMap<u32, Vec<u32>> {
    let mut index: FxHashMap<u32, Vec<u32>> = FxHashMap::default();
    let mut scanner = EntityScanner::new(content);
    let mut scan_decoder = EntityDecoder::new(content);
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        if type_name == "IFCRELVOIDSELEMENT" {
            if let Ok(entity) = scan_decoder.decode_at_with_id(id, start, end) {
                if let (Some(host), Some(opening)) = (entity.get_ref(4), entity.get_ref(5)) {
                    index.entry(host).or_default().push(opening);
                }
            }
        }
    }
    let _ = propagate_voids_to_parts(&mut index, content, decoder);
    index
}

fn volume(mesh: &Mesh) -> f64 {
    let vertex = |index: u32| {
        let base = index as usize * 3;
        [
            mesh.positions[base] as f64,
            mesh.positions[base + 1] as f64,
            mesh.positions[base + 2] as f64,
        ]
    };
    (mesh
        .indices
        .chunks_exact(3)
        .map(|triangle| {
            let (a, b, c) = (vertex(triangle[0]), vertex(triangle[1]), vertex(triangle[2]));
            a[0] * (b[1] * c[2] - b[2] * c[1])
                + a[1] * (b[2] * c[0] - b[0] * c[2])
                + a[2] * (b[0] * c[1] - b[1] * c[0])
        })
        .sum::<f64>()
        / 6.0)
        .abs()
}

fn unmatched_edges(mesh: &Mesh) -> usize {
    let key = |index: u32| {
        let base = index as usize * 3;
        let quantize = |value: f32| (value as f64 * 1.0e4).round() as i64;
        (
            quantize(mesh.positions[base]),
            quantize(mesh.positions[base + 1]),
            quantize(mesh.positions[base + 2]),
        )
    };
    let mut counts = FxHashMap::default();
    for triangle in mesh.indices.chunks_exact(3) {
        let vertices = [key(triangle[0]), key(triangle[1]), key(triangle[2])];
        for (a, b) in [(0, 1), (1, 2), (2, 0)] {
            let edge = if vertices[a] < vertices[b] {
                (vertices[a], vertices[b])
            } else {
                (vertices[b], vertices[a])
            };
            *counts.entry(edge).or_insert(0_u32) += 1;
        }
    }
    counts.values().filter(|&&uses| uses != 2).count()
}

#[test]
fn authored_vertical_strip_closes_after_real_ifc_load_3977() {
    let mut decoder = EntityDecoder::with_index(IFC, build_entity_index(IFC));
    let router = GeometryRouter::with_units(IFC, &mut decoder);
    let void_index = build_void_index(IFC, &mut decoder);
    assert_eq!(void_index.get(&WALL_ID).map(Vec::len), Some(1));

    let wall = decoder.decode_by_id(WALL_ID).expect("decode #3977 wall");
    let uncut = router.process_element(&wall, &mut decoder).expect("mesh #3977 wall");
    let cut = router
        .process_element_with_voids(&wall, &mut decoder, &void_index)
        .expect("mesh #3977 wall with its vertical strip");

    assert_eq!(unmatched_edges(&cut), 0, "the loaded wall must be watertight");
    assert!(
        volume(&cut) < volume(&uncut) - 1.0e-5,
        "the closed result must retain the authored tip cut"
    );
}
