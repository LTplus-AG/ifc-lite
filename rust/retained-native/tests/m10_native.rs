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
#[path = "../examples/compare/checks/mod.rs"]
#[allow(dead_code)]
mod checks;
use ifc_lite_retained_native::oracle::affine;
use ifc_lite_processing::element::retained_runtime::ProductOutcome;
fn kernel_status(refusal:ifc_lite_processing::element::retained_runtime::RetainedProductRefusal)->Option<i32> {
    match refusal {ifc_lite_processing::element::retained_runtime::RetainedProductRefusal::KernelFailure{status}=>Some(status),_=>None}
}
const SOURCE:&str=include_str!("../../../tests/fixtures/synthetic-retained/f-h-affine-finals.ifc");
const ADVERSARIAL:&str=include_str!("../../../tests/fixtures/synthetic-retained/f-h-affine-finals-adversarial.ifc");
fn tolerances()->serde_json::Value {serde_json::from_str(include_str!("../../../tests/fixtures/cli-retained/tolerances.d/m10.json")).unwrap()}
const LINEAR:[(u32,f64);14]=[(34,0.56),(42,0.56),(50,0.56),(58,4.48),(66,0.07),(74,13.44),(82,1.68),(95,0.56),(190,4.48),(203,1.12),(224,5.25),(234,42.),(242,0.54),(313,21.)];
#[test]
fn m10_source_oracle_matches_hand_arithmetic_and_mirror_centroids() {
    for (id,v) in LINEAR.into_iter().filter(|(id,_)|![242].contains(id)) {
        let expected=affine::expected(SOURCE.as_bytes(),id).unwrap();
        assert!((expected.iter().map(|e|e.volume).sum::<f64>()-v).abs()<1e-12,"#{id}");
    }
    let oblique=affine::expected(SOURCE.as_bytes(),313).unwrap();
    assert!((oblique[0].volume-21.).abs()<1e-12);
    let door=affine::expected(SOURCE.as_bytes(),119).unwrap();
    assert!((door[0].volume-2.*(1.35+std::f64::consts::PI*0.45f64.powi(2)/2.)).abs()<1e-12);
    let a=affine::expected(SOURCE.as_bytes(),42).unwrap();let b=affine::expected(SOURCE.as_bytes(),50).unwrap();
    for (actual,expected) in a[0].centroid.into_iter().zip([-27./70.,13./70.,1.]) {assert!((actual-expected).abs()<1e-12);}
    for (actual,expected) in b[0].centroid.into_iter().zip([27./70.,-13./70.,1.]) {assert!((actual-expected).abs()<1e-12);}
    for (id,admitted) in [(133,true),(147,false),(161,false),(175,false)] {
        let a=affine::expected(SOURCE.as_bytes(),id).unwrap();assert_eq!(a[0].chord_admitted(),admitted);
        assert!(a[0].surface_certified,"#{id}: full circles sweep to cylinders");
    }
    // The door's semicircular head is a partial arc: no opcode-18 surface certificate.
    assert!(door[0].chord_admitted()&&!door[0].surface_certified&&!door[0].admitted());
}
#[test]
fn m10_omitted_axis2_source_mirror_matches_ifcopenshell() {
    // IFC IfcSecondProjAxis defaults Axis2 to +Y. Independent IfcOpenShell
    // matrix is recorded in schema.json; do not copy the default router's
    // cross(z,x) convention into the source oracle (Refs #7955).
    let text=SOURCE.replace("#38=IFCCARTESIANTRANSFORMATIONOPERATOR3D(#35,#36,#37,1.,#3);",
        "#38=IFCCARTESIANTRANSFORMATIONOPERATOR3D(#35,$,#37,1.,#3);");
    let e=affine::expected(text.as_bytes(),42).unwrap();
    assert!(e[0].affine_final);
    for (a,b) in e[0].centroid.into_iter().zip([-27./70.,13./70.,1.]) {assert!((a-b).abs()<1e-12);}
}
#[test]
fn m10_sdk_source_oracles_and_native_reference() {
    let Some(outcomes)=support::native(SOURCE) else {return};
    let tolerance=tolerances();
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
    for (id,volume) in [(133,0.0225*std::f64::consts::PI)] {
        let p=support::shape(&outcomes,id);
        let actual=geometry_assertions::measured(p);
        for (part,e) in p.parts.iter().zip(affine::expected(SOURCE.as_bytes(),id).unwrap()) {
            let (v,c)=affine::mesh_moments(&part.positions,&part.indices,&part.world_from_object).unwrap();
            assert!(v>0.);
            let bound=e.extent*tolerance["affineFinalCentroidMetres"]["curved"]["extentFactor"].as_f64().unwrap();
            assert!(c.iter().zip(e.centroid).all(|(a,b)|(a-b).abs()<=bound),"#{id}: curved centroid {c:?} != {:?}",e.centroid);
        }
        assert_eq!(actual.defects,0,"#{id}");
        assert!((actual.volume-volume).abs()/volume<=tolerance["affineFinalVolumeRelative"]["curved"].as_f64().unwrap(),"#{id}: {actual:?}");
    }
    // M10 ruling 2026-10-29: #119 (SmSurfOfExtrusion, no opcode-18 certificate)
    // and the curved scale-ups #147/#161/#175 refuse typed `incomplete` from
    // source before any invocation; only h21's SVD policy is a kernel failure.
    for (id,code) in [(119,"incomplete"),(147,"incomplete"),(161,"incomplete"),(175,"incomplete"),(288,"operation_unsupported"),(296,"kernel_failure")] {
        assert_eq!(support::refusal(&outcomes,id).code(),code,"#{id}");
        let predicted=affine::expected(SOURCE.as_bytes(),id).map(|e|e.iter().all(|p|p.admitted()));
        if code=="incomplete" {assert_eq!(predicted,Some(false),"#{id}");}
    }
    // #7955 M5 × M10: h22 maps the clipped 3.5 m³ source by (2,3,1).
    // LINEAR above requires publication, source-oracle centroid and volume 21.
    let clipped=support::shape(&outcomes,313);
    assert!(clipped.parts.iter().all(|p|p.halfspace_clipped),"#313 must retain executed-clip lineage");
    let source=ifc_lite_core::SourceBundle::new(SOURCE.as_bytes().to_vec());
    let analytic=ifc_lite_processing::extract_analytic_quantity_sources(SOURCE.as_bytes(),None);
    let clips=ifc_lite_retained_native::oracle::clips::ClipOracle::new(&source,&analytic);
    let mut clip_tolerance:serde_json::Value=serde_json::from_str(include_str!("../../../tests/fixtures/cli-retained/tolerances.d/m5.json")).unwrap();
    let faces:serde_json::Value=serde_json::from_str(include_str!("../../../tests/fixtures/cli-retained/tolerances.d/m11-f.json")).unwrap();
    clip_tolerance.as_object_mut().unwrap().extend(faces.as_object().unwrap().clone());
    let results=checks::check(clipped,&checks::SourceContext {product_id:313,analytic:&analytic,clips:&clips,hand_volume:None},&clip_tolerance,None);
    let section:Vec<_>=results.iter().filter(|r|r.family=="clipSectionVolumeRelative").collect();
    assert_eq!(section.len(),clipped.parts.len());
    assert!(section.iter().all(|r|r.gated&&r.pass),"#313 M5 section-volume gate must execute and pass");
    assert_eq!(outcomes.len(),22);
    eprintln!("sdk witness executed: m10_sdk_source_oracles_and_native_reference");
}
#[test]
fn m10_sdk_native_parity_reference() {
    let Some(outcomes)=support::native(SOURCE) else {return};
    let mut reference=Vec::new();
    for outcome in &outcomes {
        match outcome {
            ProductOutcome::Published(p)=>{
                let volume:f64=p.parts.iter().map(|part|{let (v,_)=affine::mesh_moments(&part.positions,&part.indices,&part.world_from_object).unwrap();assert!(v>0.);v}).sum();
                reference.push(serde_json::json!({"expressId":p.product_id,"code":"published","volume":volume}));
            }
            ProductOutcome::Refused{product_id,refusal,..}=>reference.push(serde_json::json!({"expressId":product_id,"code":refusal.code(),"kernelStatus":kernel_status(*refusal)})),
        }
    }
    let adversarial=support::native(ADVERSARIAL).unwrap();
    let negative=support::shape(&adversarial,34);
    assert!((geometry_assertions::measured(negative).volume-0.56).abs()<1e-9);
    for part in &negative.parts {assert!(affine::mesh_moments(&part.positions,&part.indices,&part.world_from_object).unwrap().0>0.);}
    // Invalid IFC Scale remains a controller-only test; never corpus qualification.
    for outcome in &adversarial {match outcome {
        ProductOutcome::Published(p)=>reference.push(serde_json::json!({"fixture":"adversarial","expressId":p.product_id,"code":"published","volume":geometry_assertions::measured(p).volume})),
        ProductOutcome::Refused{product_id,refusal,..}=>reference.push(serde_json::json!({"fixture":"adversarial","expressId":product_id,"code":refusal.code(),"kernelStatus":kernel_status(*refusal)})),
    }}
    for (fixture,text) in [("scaled",include_str!("../../geometry/tests/fixtures/issue_1985_scaled_kinds.ifc")),
        ("submm",include_str!("../../geometry/tests/fixtures/issue_1985_metre_submm_scale.ifc"))] {
        for outcome in support::native(text).unwrap() {match outcome {
            ProductOutcome::Published(p)=>reference.push(serde_json::json!({"fixture":fixture,"expressId":p.product_id,"code":"published","volume":geometry_assertions::measured(&p).volume})),
            ProductOutcome::Refused{product_id,refusal,..}=>reference.push(serde_json::json!({"fixture":fixture,"expressId":product_id,"code":refusal.code(),"kernelStatus":kernel_status(refusal)})),
        }}
    }
    let path=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../wasm-bindings/m10-native-reference.output.json");
    std::fs::write(path,serde_json::to_vec_pretty(&reference).unwrap()).unwrap();
    eprintln!("sdk witness executed: m10_sdk_native_parity_reference");
}
#[test]
fn m10_sdk_issue_1985_scales_follow_narrowed_rule() {
    let Some(outcomes)=support::native(include_str!("../../geometry/tests/fixtures/issue_1985_scaled_kinds.ifc")) else {return};
    // The preregistered fallback no longer promises scaled-up curved finals; it
    // is source-determined, so #74 refuses before its tiny-radius construction.
    assert_eq!(support::refusal(&outcomes,74).code(),"incomplete");
    let outcomes=support::native(include_str!("../../geometry/tests/fixtures/issue_1985_metre_submm_scale.ifc")).unwrap();
    for id in [74,81,88,99] {let p=support::shape(&outcomes,id);for part in &p.parts {
        assert!(affine::mesh_moments(&part.positions,&part.indices,&part.world_from_object).unwrap().0>0.);
    }}
    eprintln!("sdk witness executed: m10_sdk_issue_1985_scales_follow_narrowed_rule");
}
#[test]
fn m10_sdk_sagitta_bound_at_authored_radii() {
    let mut certified=true;
    for radius in [0.00005,0.05,1.,10.] {
        let text=support::SOURCE.replace("#14=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,2.,4.);",&format!("#14=IFCCIRCLEPROFILEDEF(.AREA.,$,$,{radius});"));
        let Some(outcomes)=support::native(&text) else {return};
        let Some(p)=outcomes.iter().find_map(|o|match o {ProductOutcome::Published(p) if p.product_id==10=>Some(p),_=>None}) else {
            let refusal=support::refusal(&outcomes,10);assert_eq!(refusal.code(),"kernel_failure");
            eprintln!("M10 sagitta radius={radius}: unmeasurable, kernel status {:?}",kernel_status(refusal));
            certified=false;continue;
        };
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
        assert!(edges>0,"R={radius}: no boundary witness");
        eprintln!("M10 sagitta radius={radius}: measured={measured}, preregistered_bound={bound}");
        certified &= measured<=bound;
    }
    if !certified {
        use ifc_lite_processing::element::retained_runtime::{affine_chord_admissible,NumericalLimits};
        let limits=NumericalLimits{chord_metres:0.001,angle_degrees:5.,max_bytes:16*1024*1024};
        for radius in [0.00005,0.05,1.,10.] {
            assert!(!affine_chord_admissible(2.,radius,limits),"uncertified curved scale-up admitted");
            assert!(affine_chord_admissible(1.,radius,limits));
        }
    }
    eprintln!("M10 sagitta certificate established: {certified}");
    eprintln!("sdk witness executed: m10_sdk_sagitta_bound_at_authored_radii");
}

#[test]
fn m10_sdk_bake_matches_independent_kernel_copy_tessellation() {
    use ifc_lite_core::{SourceBundle,slot};
    use ifc_lite_retained_native::{run_model_native,ModelOptions};
    let Some(worker)=support::worker_path() else{return};
    let Some(original)=support::native(SOURCE) else{return};
    let source=SourceBundle::new(SOURCE.as_bytes().to_vec());let mut d=source.decoder();
    for id in [34,42,50,58,66,74,82,95,190,203,224,234,133] {
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
        let curved=id==133;
        let limit=tolerances()["affineFinalKernelEquivalenceRelative"][if curved{"curved"}else{"linear"}].as_f64().unwrap();
        assert!((a.volume-b.volume).abs()/a.volume<=limit,"#{id}: bake {} kernel {}",a.volume,b.volume);
        assert_eq!(b.defects,0,"#{id}");
    }
    eprintln!("sdk witness executed: m10_sdk_bake_matches_independent_kernel_copy_tessellation");
}

/// Opcode-18 phase observations (report-only, never a wall-time benchmark).
#[test]
fn m10_sdk_affine_phase_observations() {
    use ifc_lite_core::SourceBundle;
    use ifc_lite_retained_native::{ModelOptions,NativeModelDriver};
    let Some(worker)=support::worker_path() else {return};
    let mut driver=NativeModelDriver::new(worker);
    let mut cases=vec![("f-h".to_owned(),SOURCE.as_bytes().to_vec(),vec![42,50,58,66,74,82,95,119,133,147,161,175,190,203,224,234,242,288,296,313])];
    if let Some(path)=std::env::var_os("IFCLITE_M10_AFFINE_SCAN") {
        let scan:serde_json::Value=serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        for model in scan.as_array().unwrap() {
            let path=model["model"].as_str().unwrap();
            if !path.ends_with("ISSUE_034_HouseZ.ifc") {continue}
            let Ok(bytes)=std::fs::read(path) else {eprintln!("SKIP M10 HouseZ phase observations: run pnpm fixtures");continue};
            let ids=model["rows"].as_array().unwrap().iter().map(|r|r["id"].as_u64().unwrap() as u32).collect();
            cases.push(("HouseZ".to_owned(),bytes,ids));
        }
    } else {eprintln!("SKIP M10 HouseZ phase observations: IFCLITE_M10_AFFINE_SCAN is absent");}
    let mut rows=Vec::new();
    for (model,bytes,ids) in cases {
        let source=SourceBundle::new(bytes);
        for id in ids {
            let mut code=String::new();
            let (_,timing)=driver.run_model(source.clone(),&ModelOptions{ids:Some([id].into_iter().collect()),..Default::default()},|outcome,_|{
                code=match outcome {ProductOutcome::Published(_)=>"published".into(),ProductOutcome::Refused{refusal,..}=>refusal.code().into()};
            }).unwrap();
            assert!(!code.is_empty());
            rows.push(serde_json::json!({"model":model,"id":id,"code":code,"affine_ms":timing.affine_ms}));
        }
    }
    if let Some(path)=std::env::var_os("IFCLITE_M10_AFFINE_TIMINGS") {std::fs::write(path,serde_json::to_vec_pretty(&rows).unwrap()).unwrap();}
    eprintln!("sdk witness executed: m10_sdk_affine_phase_observations");
}

#[test]
fn m10_oracle_preregistered_mirror_roundoff_factor() {
    let mut e=affine::expected(SOURCE.as_bytes(),133).unwrap().remove(0);
    e.sigma_max=1.+4e-16;
    assert!(e.chord_admitted());
    e.sigma_max=1.+2e-12;
    assert!(!e.chord_admitted());
}

#[test]
fn m10_signed_volume_classification_includes_mirrored_orphan_type_maps() {
    // #7955: the signed-volume gate cannot depend on IfcProduct's Representation slot.
    #[path = "../../geometry/tests/support/m9_type_fixtures.rs"]
    mod fixtures;
    let source=ifc_lite_core::SourceBundle::new(fixtures::mirrored().into_bytes());
    let mut oracle=affine::AffineOracle::new(&source);
    assert!(oracle.is_affine_final(20));
    assert!(oracle.expected(20).is_none(),"M9 owns the independent type-map volume oracle");
    let source=ifc_lite_core::SourceBundle::new(fixtures::SOURCE.as_bytes().to_vec());
    assert!(!affine::AffineOracle::new(&source).is_affine_final(20));
}

#[test]
fn m10_affine_classification_uses_retained_selection_without_identifier() {
    // #7955 / PR #8319: optional labels must not disable the mandatory gate.
    for identifier in ["$", "''", "'Model'"] {
        let text=SOURCE.replace("#40=IFCSHAPEREPRESENTATION(#4,'Body','MappedRepresentation'",
            &format!("#40=IFCSHAPEREPRESENTATION(#4,{identifier},'MappedRepresentation'"));
        assert_ne!(text,SOURCE);
        let source=ifc_lite_core::SourceBundle::new(text.into_bytes());
        let mut oracle=affine::AffineOracle::new(&source);
        assert!(oracle.is_affine_final(42),"identifier {identifier}");
        let e=oracle.expected(42).unwrap();
        assert_eq!(e.len(),1);
        assert!((e[0].volume-0.56).abs()<1e-12);
    }
}
