// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! #7765 (D3/D13): an `IfcIndexedPolyCurve` whose point list holds a finite
//! real beyond `f32` range (`1.E39`) narrowed to an `f32` infinity in the
//! mesh. The curve reader now refuses the profile (no mesh) and counts it.

use ifc_lite_core::{build_entity_index, EntityDecoder};
use ifc_lite_geometry::{GeometryRouter, Mesh};

fn wrap(data: &str) -> String {
    format!(
        "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\nFILE_NAME('','',(''),(''),'','','');\n\
         FILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\n{data}ENDSEC;\nEND-ISO-10303-21;\n"
    )
}

/// Process entity #1: the mesh (or the error text) and the counted refusals.
fn process(data: &str) -> (Result<Mesh, String>, Vec<(String, u64)>) {
    let content = wrap(data);
    let index = build_entity_index(&content);
    let mut decoder = EntityDecoder::with_index(&content, index);
    let router = GeometryRouter::new();
    let entity = decoder.decode_by_id(1).expect("decode");
    let mesh = router.process_representation_item(&entity, &mut decoder).map_err(|e| e.to_string());
    let mut counted: Vec<(String, u64)> = router.take_unsupported_items().into_iter().collect();
    counted.sort();
    (mesh, counted)
}

/// A prism over an `IfcIndexedPolyCurve` profile with the given segments.
fn prism(x: &str, segments: &str) -> String {
    format!(
        "#1=IFCEXTRUDEDAREASOLID(#2,#5,#6,1.);\n#2=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#3);\n\
         #3=IFCINDEXEDPOLYCURVE(#4,{segments},.F.);\n\
         #4=IFCCARTESIANPOINTLIST2D(((0.,0.),({x},0.),({x},1.),(0.,1.)));\n\
         #5=IFCAXIS2PLACEMENT3D(#7,$,$);\n#6=IFCDIRECTION((0.,0.,1.));\n#7=IFCCARTESIANPOINT((0.,0.,0.));\n"
    )
}

#[test]
fn finite_polycurve_control_meshes_7765() {
    let (mesh, counted) = process(&prism("2.", "$"));
    let mesh = mesh.expect("a readable profile meshes");
    assert!(mesh.positions.iter().all(|v| v.is_finite()));
    assert!(!mesh.indices.is_empty());
    assert_eq!(counted, vec![]);
}

#[test]
fn huge_finite_polycurve_point_is_refused_7765() {
    for segments in ["$", "(IFCLINEINDEX((1,2,3,4,1)))"] {
        let (mesh, _) = process(&prism("1.E39", segments));
        let mesh = mesh.expect_err(&format!("segments {segments}: a profile beyond f32 range must be refused"));
        assert!(mesh.contains("f32"), "{mesh}");
    }
}

/// The element path counts the refused item (D3), and a wall whose profile is
/// readable alongside it is untouched.
#[test]
fn huge_finite_polycurve_point_is_counted_on_the_element_path_7765() {
    let element = |x: &str, id: u32| {
        format!(
            "#{id}=IFCWALL('0000000000000000000000',$,$,$,$,$,#{ps},$,$);\n\
             #{ps}=IFCPRODUCTDEFINITIONSHAPE($,$,(#{sr}));\n\
             #{sr}=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#{solid}));\n\
             #{solid}=IFCEXTRUDEDAREASOLID(#{p},#9000,#9001,1.);\n\
             #{p}=IFCARBITRARYCLOSEDPROFILEDEF(.AREA.,$,#{c});\n\
             #{c}=IFCINDEXEDPOLYCURVE(#{l},$,.F.);\n\
             #{l}=IFCCARTESIANPOINTLIST2D(((0.,0.),({x},0.),({x},1.),(0.,1.)));\n",
            ps = id + 1, sr = id + 2, solid = id + 3, p = id + 4, c = id + 5, l = id + 6,
        )
    };
    let common = "#9000=IFCAXIS2PLACEMENT3D(#9002,$,$);\n#9001=IFCDIRECTION((0.,0.,1.));\n#9002=IFCCARTESIANPOINT((0.,0.,0.));\n";
    let run = |x: &str| {
        let content = wrap(&format!("{}{common}", element(x, 100)));
        let index = build_entity_index(&content);
        let mut decoder = EntityDecoder::with_index(&content, index);
        let router = GeometryRouter::new();
        let wall = decoder.decode_by_id(100).expect("decode");
        let triangles = router
            .process_element_with_submeshes(&wall, &mut decoder)
            .map_or(0, |subs| subs.sub_meshes.iter().map(|s| s.mesh.indices.len() / 3).sum::<usize>());
        let mut counted: Vec<(String, u64)> = router.take_unsupported_items().into_iter().collect();
        counted.sort();
        (triangles, counted)
    };
    let (triangles, counted) = run("2.");
    assert!(triangles > 0 && counted.is_empty(), "control: {triangles} triangles, {counted:?}");
    let (triangles, counted) = run("1.E39");
    assert_eq!(triangles, 0);
    assert_eq!(counted, vec![("IfcExtrudedAreaSolid".to_string(), 1)]);
}

/// The 3D directrix reader (`IfcSweptDiskSolid`) admits the same way.
#[test]
fn huge_finite_directrix_point_is_refused_7765() {
    let sweep = |x: &str| {
        format!(
            "#4=IFCCARTESIANPOINTLIST3D(((0.,0.,0.),(10.,0.,0.),({x},5.,0.)));\n\
             #3=IFCINDEXEDPOLYCURVE(#4,$,.F.);\n#1=IFCSWEPTDISKSOLID(#3,0.5,$,$,$);\n"
        )
    };
    let (mesh, _) = process(&sweep("20."));
    assert!(mesh.is_ok_and(|m| !m.indices.is_empty()), "control: a readable directrix sweeps");
    let (mesh, _) = process(&sweep("1.E39"));
    assert!(mesh.is_err(), "a directrix beyond f32 range must be refused");
}
