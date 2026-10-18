// SPDX-License-Identifier: MPL-2.0
//! Model snapshot ownership through actual canonical geometry and presentation.
use super::*;
use super::owned_session::OwnedProductExecution;
use super::session_protocol::WorkError;
use super::session_tests::{SOURCE,assert_same,canonical,job,metadata,options,router};
use std::sync::Arc;

fn styled(color:[f32;4])->OwnedMeshProductionData {
    OwnedMeshProductionData {geometry_style_index:Arc::new([(13,GeometryStyleInfo::from_color(color))].into_iter().collect()),
        ..OwnedMeshProductionData::default()}
}
fn execute(mut session:OwnedProductExecution)->ProducedElementMeshes {
    let source=SOURCE.to_owned();
    let mut decoder=EntityDecoder::new(&source);
    let router=router(&mut decoder);
    while session.advance(&mut decoder,&router).unwrap() {}
    session.finish(&decoder,&router).unwrap()
}
fn dormant(context:&Arc<OwnedMeshProductionContext>)->OwnedProductExecution {
    let mut decoder=EntityDecoder::new(SOURCE);
    let router=router(&mut decoder);
    let entity=decoder.decode_by_id(10).unwrap();
    OwnedProductExecution::new(&job(&entity,&metadata(10)),context,&options(),&mut decoder,&router).unwrap()
}

#[test]
fn immutable_style_snapshot_survives_caller_drop_mutation_new_revision_and_dormant_thread_transfer() {
    let model=ProductionModel::new();
    let red=[0.9,0.1,0.2,1.];let green=[0.1,0.8,0.2,1.];
    let mut data=styled(red);
    let styles=Arc::downgrade(&data.geometry_style_index);
    let context=model.snapshot(data.clone());
    let before=styles.strong_count();
    let session=dormant(&context);
    assert_eq!(styles.strong_count(),before,"a product clones only the outer snapshot Arc");
    Arc::make_mut(&mut data.geometry_style_index).insert(13,GeometryStyleInfo::from_color(green));
    let newer=model.snapshot(data);
    assert_ne!(context.id(),newer.id());
    assert!(context.validate_source().is_ok(),"new same-source snapshot does not expire old work");
    drop(context);drop(model);
    let actual=std::thread::spawn(move||execute(session)).join().unwrap();
    assert_eq!(actual.meshes[0].color,red,"owned view retains the actual original style map");
    assert!((actual.geometry_volume.unwrap()-24.).abs()<1e-5);
    let changed=execute(dormant(&newer));
    assert_eq!(changed.meshes[0].color,green);
    assert_eq!(actual.geometry_hash,changed.geometry_hash,"appearance mutation does not alter geometry");
    assert_eq!(actual.meshes[0].positions,changed.meshes[0].positions);
    assert_eq!(actual.meshes[0].name.as_deref(),Some("product 10"));
}

#[test]
fn explicit_invalidation_rejects_dormant_and_completed_owned_publication_without_abort() {
    let model=ProductionModel::new();
    let context=model.snapshot(OwnedMeshProductionData::default());
    let mut session=dormant(&context);
    model.invalidate_source();
    assert_eq!(session.request().unwrap_err(),WorkError::StaleSource);
    let mut decoder=EntityDecoder::new(SOURCE);let router=router(&mut decoder);
    let entity=decoder.decode_by_id(10).unwrap();
    assert_eq!(produce_element_meshes_owned(&job(&entity,&metadata(10)),&context,&options(),&mut decoder,&router).err(),
        Some(ProductionContextError::StaleSource));
    assert!(decoder.try_execution_lease().is_ok(),"stale planning acquired no reservation");
    drop(session);
    let fresh=model.snapshot(OwnedMeshProductionData::default());
    let mut session=OwnedProductExecution::new(&job(&entity,&metadata(10)),&fresh,&options(),&mut decoder,&router).unwrap();
    while session.advance(&mut decoder,&router).unwrap() {}
    model.invalidate_source();
    assert_eq!(session.finish(&decoder,&router).err(),Some(WorkError::StaleSource));
    let next=model.snapshot(OwnedMeshProductionData::default());
    let actual=produce_element_meshes_owned(&job(&entity,&metadata(10)),&next,&options(),&mut decoder,&router).unwrap();
    assert_same(&actual,&canonical(10,false));
}

#[test]
fn independent_loads_of_identical_maps_do_not_share_completion_identity() {
    let first=ProductionModel::new();let second=ProductionModel::new();
    let data=OwnedMeshProductionData::default();
    let a=first.snapshot(data.clone());let b=second.snapshot(data);
    assert_ne!(a.id(),b.id());
    first.invalidate_source();
    assert_eq!(a.validate_source(),Err(ProductionContextError::StaleSource));
    let actual=execute(dormant(&b));
    assert_same(&actual,&canonical(10,false));
}
