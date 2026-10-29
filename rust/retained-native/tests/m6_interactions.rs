// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! #7955: M6 with M10 affine finals and M11 appearance, faces and instancing.
mod support;
use ifc_lite_retained_native::oracle::{affine, normals::{self,Surface}};
const SOURCE: &str = include_str!("../../../tests/fixtures/synthetic-retained/f-f-halfspaces.ifc");
fn source(text: &str, id: u32) -> Vec<Surface> {
    normals::surfaces(text.as_bytes(),&ifc_lite_processing::extract_analytic_quantity_sources(text.as_bytes(),None),id).unwrap()
}
fn direction(surfaces: &[Surface], point: [f64;3], normal: [f64;3]) {
    assert!(surfaces.iter().any(|s|s.sample(point).is_some_and(|(n,d)|d<1e-12&&normals::angle(n,normal)<1e-12)),
        "missing source normal {normal:?} at {point:?}");
}
#[test]
fn m6_source_normals_include_bounded_sides_arcs_and_boxed_plane() {
    let bounded = source(SOURCE,1000);
    direction(&bounded,[1.,1.,2.],[0.,0.,1.]);
    direction(&bounded,[0.5,1.,3.],[1.,0.,0.]);
    direction(&bounded,[2.5,1.,3.],[-1.,0.,0.]);
    let arc = source(SOURCE,1005);
    let q = std::f64::consts::FRAC_1_SQRT_2;
    direction(&arc,[2.*q,2.*q,3.],[-q,-q,0.]);
    direction(&source(SOURCE,1007),[1.,1.,2.],[0.,0.,1.]);
    // The Enclosure is neither decoded nor used to invent source faces.
    let absent = SOURCE.lines().filter(|s|!s.contains("IFCBOUNDINGBOX(")).collect::<Vec<_>>().join("\n");
    assert_eq!(serde_json::to_value(source(&absent,1007)).unwrap(),serde_json::to_value(source(SOURCE,1007)).unwrap());
}
fn affine_boxed() -> String {
    SOURCE.replace("#383=IFCSHAPEREPRESENTATION(#4,'Body','CSG',(#345));",
        "#383=IFCSHAPEREPRESENTATION(#4,'Body','MappedRepresentation',(#9004));\n\
         #9001=IFCSHAPEREPRESENTATION(#4,'Body','CSG',(#345));\n\
         #9002=IFCREPRESENTATIONMAP(#2,#9001);\n\
         #9003=IFCCARTESIANTRANSFORMATIONOPERATOR3DNONUNIFORM(#9005,#9006,#1,2.,#3,3.,1.);\n\
         #9004=IFCMAPPEDITEM(#9002,#9003);\n\
         #9005=IFCDIRECTION((-1.,0.,0.));\n\
         #9006=IFCDIRECTION((0.,1.,0.));")
}
#[test]
fn m6_source_boxed_plane_survives_mirrored_nonuniform_final() {
    direction(&source(&affine_boxed(),1007),[-2.,3.,2.],[0.,0.,1.]);
}
#[test]
fn m6_sdk_clipped_faces_normals_appearance_and_instance_exclusion() {
    let Some(outcomes) = support::native(SOURCE) else {return};
    for id in [1000,1001,1002,1003,1004,1005,1007,1008,1009,1014,1015] {
        let p = support::shape(&outcomes,id);
        let check = normals::check(p,&source(SOURCE,id)).unwrap();
        assert_eq!(check.unattributed,0,"#{id}: {check:?}");
        assert!(check.planar_radians<1e-6&&check.curved_radians<0.0873&&check.unit_error<1e-12,"#{id}: {check:?}");
        assert!(p.cuts>0,"#{id}");
        for part in &p.parts {
            assert!(part.instance_key.is_none(),"#{id}: clipped products cannot instance");
            assert!(part.appearance.is_some(),"#{id}: appearance must be discharged");
            let faces = part.faces.as_ref().expect("source faces must publish");
            assert_eq!(faces.triangles.len(),part.indices.len()/3);
            assert!(faces.table.iter().any(|key|key.via!=0),"#{id}: clip face provenance");
        }
    }
    println!("sdk witness executed: m6_presentation_interactions");
}
#[test]
fn m6_sdk_mirrored_scaled_boxed_final_keeps_shape_and_clip_lineage() {
    let text = affine_boxed();
    let Some(outcomes) = support::native(&text) else {return};
    let p = support::shape(&outcomes,1007);
    let mut volume = 0.;
    for part in &p.parts {
        let (v,c) = affine::mesh_moments(&part.positions,&part.indices,&part.world_from_object).unwrap();
        volume += v;
        for (a,b) in c.into_iter().zip([-4.,6.,1.]) {assert!((a-b).abs()<1e-9);}
        assert!(part.halfspace_clipped&&part.instance_key.is_none());
        assert!(part.faces.is_some()&&part.normals.is_some()&&part.appearance.is_some());
    }
    assert!((volume-192.).abs()<192e-6);
    println!("sdk witness executed: m6_affine_boxed_interaction");
}
#[test]
fn m6_sdk_authored_style_survives_bounded_clip() {
    let text = SOURCE.replace("ENDSEC;\nEND-ISO", "\
        #9100=IFCCOLOURRGB($,0.2,0.4,0.6);\n\
        #9101=IFCSURFACESTYLERENDERING(#9100,0.25,$,$,$,$,$,$,.NOTDEFINED.);\n\
        #9102=IFCSURFACESTYLE($,.BOTH.,(#9101));\n\
        #9103=IFCSTYLEDITEM(#333,(#9102),$);\nENDSEC;\nEND-ISO");
    let Some(outcomes) = support::native(&text) else {return};
    let p = support::shape(&outcomes,1000);
    assert!(p.cuts>0);
    for part in &p.parts {
        assert_eq!(part.appearance.as_ref().unwrap().rgba,[0.2,0.4,0.6,0.75]);
        assert!(part.instance_key.is_none());
    }
    println!("sdk witness executed: m6_clipped_style");
}
