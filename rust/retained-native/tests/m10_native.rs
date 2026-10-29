// SPDX-License-Identifier: MPL-2.0
#![cfg(feature = "retained-runtime")]
//! #7955 M10: source arithmetic, real SDK, signed winding, centroid and chord.
mod support;
#[path = "../examples/compare/metrics.rs"]
#[allow(dead_code)]
mod metrics;
#[path = "support/geometry_assertions.rs"]
#[allow(dead_code)]
mod geometry_assertions;
use ifc_lite_retained_native::oracle::affine;
use ifc_lite_processing::element::retained_runtime::ProductOutcome;
const SOURCE:&str=include_str!("../../../tests/fixtures/synthetic-retained/f-h-affine-finals.ifc");
const ADVERSARIAL:&str=include_str!("../../../tests/fixtures/synthetic-retained/f-h-affine-finals-adversarial.ifc");
fn tolerances()->serde_json::Value {serde_json::from_str(include_str!("../../../tests/fixtures/cli-retained/tolerances.d/m10.json")).unwrap()}
const LINEAR:[(u32,f64);13]=[(34,0.56),(42,0.56),(50,0.56),(58,4.48),(66,0.07),(74,13.44),(82,1.68),(95,0.56),(190,4.48),(203,1.12),(224,5.25),(234,42.),(242,0.54)];
#[test]
fn m10_source_oracle_matches_hand_arithmetic_and_mirror_centroids() {
    for (id,v) in LINEAR.into_iter().filter(|(id,_)|![224,234,242].contains(id)) {
        let expected=affine::expected(SOURCE.as_bytes(),id).unwrap();
        assert!((expected.iter().map(|e|e.volume).sum::<f64>()-v).abs()<1e-12,"#{id}");
    }
    let a=affine::expected(SOURCE.as_bytes(),42).unwrap();let b=affine::expected(SOURCE.as_bytes(),50).unwrap();
    for (actual,expected) in a[0].centroid.into_iter().zip([-27./70.,13./70.,1.]) {assert!((actual-expected).abs()<1e-12);}
    for (actual,expected) in b[0].centroid.into_iter().zip([27./70.,-13./70.,1.]) {assert!((actual-expected).abs()<1e-12);}
    for (id,admitted) in [(133,true),(147,false),(161,true),(175,true)] {
        let a=affine::expected(SOURCE.as_bytes(),id).unwrap();assert_eq!(a[0].chord_admitted(0.001,5.),admitted);
    }
}
#[test]
fn m10_sdk_source_oracles_and_native_reference() {
    let Some(outcomes)=support::native(SOURCE) else {return};
    let tolerance=tolerances();let mut reference=Vec::new();
    for (id,volume) in LINEAR {
        let p=support::shape(&outcomes,id);let actual=geometry_assertions::measured(p);
        assert_eq!(actual.defects,0,"#{id}: {actual:?}");
        assert!((actual.volume-volume).abs()/volume<=tolerance["affineFinalVolumeRelative"]["linear"].as_f64().unwrap(),"#{id}: {actual:?}");
        if let Some(expected)=affine::expected(SOURCE.as_bytes(),id).filter(|_|p.cuts==0) {
            assert_eq!(expected.len(),p.parts.len());
            for (part,e) in p.parts.iter().zip(expected) {
                let (v,c)=affine::mesh_moments(&part.positions,&part.indices,&part.world_from_object).unwrap();assert!(v>0.);
                let b=e.bbox.unwrap();let extent=(0..3).map(|i|b[i+3]-b[i]).fold(0.,f64::max);
                let tol=&tolerance["affineFinalCentroidMetres"]["linear"];
                let bound=tol["absolute"].as_f64().unwrap()+extent*tol["extentFactor"].as_f64().unwrap();
                assert!(c.iter().zip(e.centroid).all(|(a,b)|(a-b).abs()<=bound),"#{id}: {c:?} != {:?}",e.centroid);
                eprintln!("affine_kappa #{id}: {}",e.kappa);
            }
        }
    }
    for (id,volume) in [(119,2.*(1.35+std::f64::consts::PI*0.45f64.powi(2)/2.)),(133,0.0225*std::f64::consts::PI),
        (161,5.*std::f64::consts::PI),(175,0.015*std::f64::consts::PI)] {
        let actual=geometry_assertions::measured(support::shape(&outcomes,id));
        assert_eq!(actual.defects,0,"#{id}");
        assert!((actual.volume-volume).abs()/volume<=tolerance["affineFinalVolumeRelative"]["curved"].as_f64().unwrap(),"#{id}: {actual:?}");
    }
    for (id,code) in [(147,"incomplete"),(288,"operation_unsupported"),(296,"kernel_failure")] {
        assert_eq!(support::refusal(&outcomes,id).code(),code,"#{id}");
    }
    // M5 is a qualification dependency: this schema-valid post-clip mapping
    // must become volume 15 after M5 lands; preserve the current typed refusal.
    assert_eq!(support::refusal(&outcomes,313).code(),"operation_unsupported");
    assert_eq!(outcomes.len(),22);
    for outcome in &outcomes {
        match outcome {
            ProductOutcome::Published(p)=>{
                let volume:f64=p.parts.iter().map(|part|{let (v,_)=affine::mesh_moments(&part.positions,&part.indices,&part.world_from_object).unwrap();assert!(v>0.);v}).sum();
                reference.push(serde_json::json!({"expressId":p.product_id,"code":"published","volume":volume}));
            }
            ProductOutcome::Refused{product_id,refusal,..}=>reference.push(serde_json::json!({"expressId":product_id,"code":refusal.code()})),
        }
    }
    let adversarial=support::native(ADVERSARIAL).unwrap();
    // Invalid IFC Scale remains a controller-only test; never corpus qualification.
    for outcome in &adversarial {match outcome {
        ProductOutcome::Published(p)=>reference.push(serde_json::json!({"fixture":"adversarial","expressId":p.product_id,"code":"published","volume":geometry_assertions::measured(p).volume})),
        ProductOutcome::Refused{product_id,refusal,..}=>reference.push(serde_json::json!({"fixture":"adversarial","expressId":product_id,"code":refusal.code()})),
    }}
    let path=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../wasm-bindings/m10-native-reference.output.json");
    std::fs::write(path,serde_json::to_vec_pretty(&reference).unwrap()).unwrap();
    eprintln!("sdk witness executed: m10_sdk_source_oracles_and_native_reference");
}
#[test]
fn m10_sdk_issue_1985_scales_publish() {
    for (text,ids) in [(include_str!("../../geometry/tests/fixtures/issue_1985_scaled_kinds.ifc"),vec![74]),
        (include_str!("../../geometry/tests/fixtures/issue_1985_metre_submm_scale.ifc"),vec![74,81,88,99])] {
        let Some(outcomes)=support::native(text) else {return};
        for id in ids {let p=support::shape(&outcomes,id);for part in &p.parts {assert!(affine::mesh_moments(&part.positions,&part.indices,&part.world_from_object).unwrap()0.0>0.);}}
    }
    eprintln!("sdk witness executed: m10_sdk_issue_1985_scales_publish");
}
#[test]
fn m10_sdk_sagitta_bound_at_authored_radii() {
    for radius in [0.00005,0.05,1.,10.] {
        let text=support::SOURCE.replace("#14=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,2.,4.);",&format!("#14=IFCCIRCLEPROFILEDEF(.AREA.,$,$,{radius});"));
        let Some(outcomes)=support::native(&text) else {return};let p=support::shape(&outcomes,10);
        let bound=(radius*(1.-5f64.to_radians().cos())).min(0.001)*(1.+1e-12);
        let mut measured:f64=0.;let mut edges=0;
        for part in &p.parts {for t in part.indices.chunks_exact(3) {
            let z:Vec<_>=t.iter().map(|&i|part.positions[i as usize*3+2]).collect();
            if z.iter().all(|v|(v-z[0]).abs()<1e-12) {continue} // cap triangles
            for (a,b) in [(t[0],t[1]),(t[1],t[2]),(t[2],t[0])] {
                let a=&part.positions[a as usize*3..];let b=&part.positions[b as usize*3..];
                if (a[2]-b[2]).abs()<1e-12 {
                    let sag=radius-((a[0]+b[0])/2.).hypot((a[1]+b[1])/2.);
                    measured=measured.max(sag);edges+=1;
                }
            }
        }}
        assert!(edges>0,"R={radius}: no boundary witness");assert!(measured<=bound,"R={radius}: {measured} > {bound}");
    }
    eprintln!("sdk witness executed: m10_sdk_sagitta_bound_at_authored_radii");
}

#[test]
fn m10_sdk_bake_matches_independent_kernel_copy_tessellation() {
    use ifc_lite_core::{SourceBundle,slot};
    use ifc_lite_retained_native::{run_model_native,ModelOptions};
    let Some(worker)=support::worker_path() else{return};
    let Some(original)=support::native(SOURCE) else{return};
    let source=SourceBundle::new(SOURCE.as_bytes().to_vec());let mut d=source.decoder();
    for id in [34,42,50,58,66,74,82,95,119,133,161,175,190,203,224,234] {
        let product=d.decode_by_id(id).unwrap();
        let reps=d.decode_by_id(product.ref_at(slot::IfcProduct::REPRESENTATION).unwrap()).unwrap();
        let rep_id=reps.ref_list_at(slot::IfcProductRepresentation::REPRESENTATIONS).unwrap()[0];
        let rep=d.decode_by_id(rep_id).unwrap();let items=rep.ref_list_at(slot::IfcRepresentation::ITEMS).unwrap();
        let mut unions=String::new();let mut refs=Vec::new();
        for (i,item) in items.iter().enumerate() {let new=900001+i;refs.push(format!("#{new}"));unions.push_str(&format!("#{new}=IFCBOOLEANRESULT(.UNION.,#{item},#{item});\n"));}
        // This is explicitly a controller cross-check, not schema qualification:
        // IFC4 excludes mapped operands. The qualifying product remains SOURCE.
        let replaced=format!("#{rep_id}=IFCSHAPEREPRESENTATION(#4,'Body','CSG',({}));",refs.join(","));
        let mut text=SOURCE.lines().map(|line|if line.starts_with(&format!("#{rep_id}=")){replaced.as_str()}else{line}).collect::<Vec<_>>().join("\n");
        text=text.replace("ENDSEC;\nEND-ISO",&format!("{unions}ENDSEC;\nEND-ISO"));
        let mut outcomes=Vec::new();run_model_native(SourceBundle::new(text.into_bytes()),std::path::Path::new(&worker),
            &ModelOptions{ids:Some([id].into_iter().collect()),..Default::default()},|o|outcomes.push(o)).unwrap();
        let a=geometry_assertions::measured(support::shape(&original,id));let b=geometry_assertions::measured(support::shape(&outcomes,id));
        let curved=[119,133,161,175].contains(&id);
        let limit=tolerances()["affineFinalKernelEquivalenceRelative"][if curved{"curved"}else{"linear"}].as_f64().unwrap();
        assert!((a.volume-b.volume).abs()/a.volume<=limit,"#{id}: bake {} kernel {}",a.volume,b.volume);
        assert_eq!(b.defects,0,"#{id}");
    }
    eprintln!("sdk witness executed: m10_sdk_bake_matches_independent_kernel_copy_tessellation");
}
