// SPDX-License-Identifier: MPL-2.0
//! Round3: actual authored-to-runtime consumers, with independent analytic oracles.
#![cfg(not(target_arch="wasm32"))]
use ifc_lite_core::SourceBundle;
use ifc_lite_geometry::document::{BooleanOperation, EvaluationContract};
use ifc_lite_geometry_runtime::{MeshLimits, RetainedDependency, SmlibWorker};
use ifc_lite_processing::{authored_geometry::{plan_authored_geometry, evaluator::AuthoredRetainedDocument},
    element::{OwnedMeshProductionData, ProductionModel}};
use std::{collections::HashSet, f64::consts::PI};
const MODEL:&str=include_str!("../../geometry/tests/fixtures/mapped_instances_synthetic.ifc");
fn disk(curved:bool)->String {
    let source=MODEL.replace("#3=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);","#3=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);")
        .replace("#12=IFCEXTRUDEDAREASOLID(#8,#11,#9,1.0);","#12=IFCSWEPTDISKSOLID(#1003,250.,$,$,$);");
    let data=if curved {
        "#1000=IFCCARTESIANPOINT((4000.,0.,0.));#1001=IFCCARTESIANPOINT((4000.,4000.,0.));#1002=IFCCARTESIANPOINT((0.,4000.,0.));#1003=IFCRATIONALBSPLINECURVEWITHKNOTS(2,(#1000,#1001,#1002),.UNSPECIFIED.,.F.,.F.,(3,3),(0.,1.),.UNSPECIFIED.,(1.,0.7071067811865476,1.));"
    } else {
        "#1000=IFCCARTESIANPOINT((0.,0.,0.));#1001=IFCCARTESIANPOINT((0.,0.,5000.));#1003=IFCRATIONALBSPLINECURVEWITHKNOTS(1,(#1000,#1001),.UNSPECIFIED.,.F.,.F.,(2,2),(0.,1.),.UNSPECIFIED.,(2.,3.));"
    };
    source.replace("ENDSEC;\nEND-ISO-10303-21;",&format!("{data}\nENDSEC;\nEND-ISO-10303-21;"))
}
#[test]
fn retained_round3_rational_disk_recipe_preserves_original_coefficients_and_converts_millimetres_once() {
    for curved in [false,true] {
        let input=disk(curved);
        let plan=plan_authored_geometry(input.as_bytes(),Some(&HashSet::from([31])));
        assert_eq!(plan.recipes.len(),1,"{:?}",plan.diagnostics);
        let key=&plan.recipes[0].source;
        let document=AuthoredRetainedDocument::admit_source(&plan,key,1,1).unwrap();
        let request=document.prepare(key,EvaluationContract::RetainedBrep,1).unwrap();
        let payload=request.recipe().lower().unwrap();
        assert_eq!(payload.format,2);
        let radius=f64::from_le_bytes(payload.bytes[16..24].try_into().unwrap());
        assert_eq!(radius,0.25);
        assert_eq!(payload.source_from_evaluation[0],1000.);
        assert_eq!(payload.evaluation_from_source[0],0.001);
        let ifc_lite_geometry::document::RetainedConstruction::SweptDisk(recipe)=request.recipe() else {panic!("disk recipe")};
        let ifc_lite_geometry::analytic::OwnedDirectrix::Rational(path)=recipe.source.owned_directrix.as_ref().unwrap() else {panic!("original rational")};
        assert_eq!(path.control_points[1],if curved {[4000.,4000.,0.]} else {[0.,0.,5000.]});
        assert_eq!(path.weights,if curved {vec![1.,0.7071067811865476,1.]} else {vec![2.,3.]});
        assert_eq!(path.parameter_range,[0.,1.]);
        assert_eq!(recipe.source.source.as_ref().unwrap().root_entity_id,12);
        assert_eq!(request.recipe().lower().unwrap().bytes,payload.bytes);
    }
}
#[test]
fn retained_round3_actual_bound_rational_pipe_consumes_the_authenticated_source() {
    let Some(executable)=std::env::var_os("IFCLITE_SMLIB_WORKER") else {
        eprintln!("SKIP actual retained rational pipe: compile pinned SDK worker and set IFCLITE_SMLIB_WORKER");return;
    };
    for curved in [false,true] {
        let source=SourceBundle::new(disk(curved).into_bytes());
        let model=ProductionModel::from_source(source.clone());
        let context=model.snapshot(OwnedMeshProductionData::default());
        let mut decoder=source.decoder();
        let plan=context.admit_authored_plan(&mut decoder).unwrap();
        let key=&plan.plan().recipes.iter().find(|r|r.product_id==31).unwrap().source;
        let mut document=plan.admit_source(key).unwrap();
        let mut worker=SmlibWorker::spawn(&executable).unwrap();
        let first=document.issue(key,&worker).unwrap();
        assert!(document.execute(first,&mut worker,0.001,5.,MeshLimits::default()).is_err(),"capability alone cannot qualify pipe");
        assert_eq!(worker.qualify_rational_disks().unwrap().len(),2);
        let issued=document.issue(key,&worker).unwrap();
        let work=document.execute(issued,&mut worker,0.0001,5.,MeshLimits::default()).unwrap();
        let expected=PI*0.25*0.25*if curved {2.*PI} else {5.};
        assert!((worker.volume(work.realization().solid(),1e-8).unwrap()-expected).abs()<expected*1e-4);
        assert!(worker.is_manifold(work.realization().solid()).unwrap());
        assert!(!work.realization().completion().tessellation.indices.is_empty());
    }
}
#[test]
fn retained_round3_actual_copied_frames_and_boolean_opening_preserve_shared_sources() {
    let Some(executable)=std::env::var_os("IFCLITE_SMLIB_WORKER") else {
        eprintln!("SKIP actual retained common-frame dependencies: set IFCLITE_SMLIB_WORKER");return;
    };
    let plan=plan_authored_geometry(MODEL.as_bytes(),Some(&HashSet::from([31])));
    let key=&plan.recipes[0].source;
    let document=AuthoredRetainedDocument::admit_source(&plan,key,1,1).unwrap();
    let mut worker=SmlibWorker::spawn(executable).unwrap();
    let request=document.prepare(key,EvaluationContract::RetainedBrep,worker.incarnation()).unwrap();
    let a=worker.evaluate_retained_extrusion(request.clone(),0.001,5.,MeshLimits::default()).unwrap();
    let b=worker.evaluate_retained_extrusion(request,0.001,5.,MeshLimits::default()).unwrap();
    let mut left=[1.,0.,0.,0.,0.,1.,0.,0.,0.,0.,1.,0.,1e9,2e9,3e9,1.];
    let mut right=left;right[12]+=0.5;
    let cut=worker.evaluate_retained_boolean(RetainedDependency::Source{realization:&a,world_from_source:left},
        RetainedDependency::Source{realization:&b,world_from_source:right},BooleanOperation::Difference,0.001,5.,MeshLimits::default()).unwrap();
    assert_eq!(cut.operation_identity().left,a.solid());
    assert_eq!(cut.operation_identity().right,b.solid());
    assert_eq!(cut.operation_identity().operation,BooleanOperation::Difference);
    assert!((worker.volume(cut.solid(),1e-8).unwrap()-0.5).abs()<1e-6);
    assert!((worker.volume(a.solid(),1e-8).unwrap()-1.).abs()<1e-6);
    assert!((worker.volume(b.solid(),1e-8).unwrap()-1.).abs()<1e-6);
    assert!(cut.world_from_evaluation()[12]>1e8,"survey translation remains outside SDK");
    left[0] = -1.;
    assert!(worker.evaluate_retained_boolean(RetainedDependency::Source{realization:&a,world_from_source:left},
        RetainedDependency::Result(&cut),BooleanOperation::Union,0.001,5.,MeshLimits::default()).is_err());
    worker.release(a.solid()).unwrap();worker.release(b.solid()).unwrap();
    assert!(a.validate_live().is_err() && b.validate_live().is_err());
    cut.validate_live().unwrap();
    assert!((worker.volume(cut.solid(),1e-8).unwrap()-0.5).abs()<1e-6,
        "copied result owns its shape independently of released source objects");
}

#[test]
fn retained_round3_actual_authoring_fixture_sources_obey_analytic_sweep_volume() {
    use ifc_lite_geometry::analytic::{AnalyticStatus, ProfileLoopKind};
    use ifc_lite_processing::authored_geometry::AuthoredDefinition;
    let Some(content)=ifc_lite_testkit::fixture_bytes("ara3d/AC20-FZK-Haus.ifc") else {
        return;
    };
    let Some(executable)=std::env::var_os("IFCLITE_SMLIB_WORKER") else {
        eprintln!("SKIP actual authoring fixture SDK consumption: set IFCLITE_SMLIB_WORKER");return;
    };
    let source=SourceBundle::new(content);
    let model=ProductionModel::from_source(source.clone());
    let context=model.snapshot(OwnedMeshProductionData::default());
    let mut decoder=source.decoder();let plan=context.admit_authored_plan(&mut decoder).unwrap();
    let mut worker=SmlibWorker::spawn(executable).unwrap();worker.qualify_ordered_regions().unwrap();
    let mut consumed=0;let mut refused=0;let mut retained=Vec::new();
    for definition in &plan.plan().definitions {
        let AuthoredDefinition::Extrusion(source)=definition else {continue};
        if !matches!(source.source.status,AnalyticStatus::Complete) {refused+=1;continue;}
        let Some(profile)=source.source.profile.as_ref() else {refused+=1;continue};
        let area: f64=profile.loops.iter().map(|boundary| if boundary.kind==ProfileLoopKind::Outer {
            boundary.signed_area.abs()
        } else {-boundary.signed_area.abs()}).sum();
        let u=plan.plan().length_unit_scale;
        let axis=source.source.axis_unit_vector.unwrap();
        let expected=area*source.source.depth.unwrap()*axis[2].abs()*u*u*u;
        let key=&source.key;
        let Ok(mut document)=plan.admit_source(key) else {refused+=1;continue};
        let issued=document.issue(key,&worker).unwrap();
        let work=document.execute(issued,&mut worker,0.001,5.,MeshLimits::default()).unwrap();
        let volume=worker.volume(work.realization().solid(),1e-8).unwrap();
        assert!(expected>0. && (volume-expected).abs()<expected*1e-4,"source #{} volume {volume} vs authored invariant {expected}",key.solid_id);
        assert!(worker.is_manifold(work.realization().solid()).unwrap());
        assert!(!work.realization().completion().tessellation.indices.is_empty());
        // Successful receipts conservatively own the process domain. Keep this
        // bounded set alive until the source-only inspection has finished.
        retained.push(work);
        consumed+=1;if consumed==8 {break;}
    }
    assert!(consumed>0,"no authoring-fixture source consumed; explicit refusals={refused}");
}
