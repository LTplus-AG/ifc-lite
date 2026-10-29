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
#[path="support/m6_affine.rs"]
mod m6_affine;
use m6_affine::affine_boxed;
#[test]
fn m6_source_boxed_plane_survives_mirrored_nonuniform_final() {
    direction(&source(&affine_boxed(),1007),[-2.,3.,2.],[0.,0.,1.]);
}
#[test]
fn m6_sdk_clipped_faces_normals_appearance_and_instance_exclusion() {
    let Some(outcomes) = support::native(SOURCE) else {return};
    for (id,cutter) in [(1000,307),(1001,308),(1002,335),(1003,307),(1004,307),
        (1005,340),(1007,344),(1008,315),(1009,347),(1014,308),(1015,367)] {
        let p = support::shape(&outcomes,id);
        let check = normals::check(p,&source(SOURCE,id)).unwrap();
        assert_eq!(check.unattributed,0,"#{id}: {check:?}");
        assert!(check.planar_radians<1e-9&&check.curved_radians<0.0873&&check.unit_error<1e-12,"#{id}: {check:?}");
        for part in &p.parts {
            assert!(part.instance_key.is_none(),"#{id}: clipped products cannot instance");
            assert!(part.appearance.is_some(),"#{id}: appearance must be discharged");
            let faces = part.faces.as_ref().expect("source faces must publish");
            assert_eq!(faces.triangles.len(),part.indices.len()/3);
            // A Boolean clip names its halfspace item directly; `via` is the
            // opening-element id only for an M3 opening subtraction.
            assert!(faces.table.iter().any(|key|key.item==cutter&&key.via==0&&key.role=="halfspace"),
                "#{id}: missing authored cut-plane face #{cutter}: {:?}",faces.table);
        }
    }
    println!("sdk witness executed: m6_presentation_interactions");
}
#[test]
fn m6_sdk_mirrored_scaled_boxed_final_keeps_shape_and_clip_lineage() {
    let text = affine_boxed();
    let Some(outcomes) = support::native(&text) else {return};
    let p = support::shape(&outcomes,1007);
    let check = normals::check(p,&source(&text,1007)).unwrap();
    assert_eq!(check.unattributed,0,"{check:?}");
    assert!(check.planar_radians<1e-9&&check.unit_error<1e-12,"{check:?}");
    let mut volume = 0.;
    for part in &p.parts {
        let (v,c) = affine::mesh_moments(&part.positions,&part.indices,&part.world_from_object).unwrap();
        assert!(v>0.,"mirrored final must retain outward winding");
        volume += v;
        for (a,b) in c.into_iter().zip([-4.,6.,1.]) {assert!((a-b).abs()<1e-9);}
        assert!(part.halfspace_clipped&&part.instance_key.is_none());
        assert!(part.faces.is_some()&&part.normals.is_some()&&part.appearance.is_some());
        assert_eq!(part.faces.as_ref().unwrap().triangles.len(),part.indices.len()/3);
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
    let volume: f64 = p.parts.iter().map(|part|affine::mesh_moments(&part.positions,&part.indices,&part.world_from_object).unwrap().0).sum();
    assert!((volume-56.).abs()<56e-6,"the authored 8 m³ bounded cut must execute");
    for part in &p.parts {
        assert_eq!(part.appearance.as_ref().unwrap().rgba,[0.2,0.4,0.6,0.75]);
        assert!(part.instance_key.is_none());
    }
    println!("sdk witness executed: m6_clipped_style");
}
