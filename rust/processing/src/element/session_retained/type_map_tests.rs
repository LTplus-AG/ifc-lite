// SPDX-License-Identifier: MPL-2.0
//! #7955: actual type-map transactions and canonical orphan/tag decisions.
use super::*;
#[test]
fn h2a2_native_type_maps_use_canonical_mode_classes_and_original_origin_frames() {
    let Some(mut worker) = worker() else { return };
    for (instantiated,mode,count,class) in [
        (false,TypeGeometryMode::SuppressInstanced,2,1),
        (true,TypeGeometryMode::SuppressInstanced,0,0),
        (true,TypeGeometryMode::EmitTagged,2,2),
    ] {
        let bytes = if instantiated { SOURCE.replace("ENDSEC;END-ISO",
            "#200=IFCRELDEFINESBYTYPE('r',$,$,$,(#10,#20),#60);ENDSEC;END-ISO") } else { SOURCE.to_string() };
        let source = SourceBundle::new(bytes.as_bytes().to_vec());
        let mut decoder = source.decoder();
        let router = GeometryRouter::with_units(&bytes,&mut decoder);
        let context = ProductionModel::from_source(source.clone()).snapshot(Default::default());
        let entity = decoder.decode_by_id(60).unwrap();
        let metadata = metadata(60);
        let maps = plan_type_geometry(&[61,71],&FxHashSet::default(),instantiated,mode);
        let mut job = job(&entity,&metadata);
        job.kind = ElementJobKind::TypeProduct { rep_maps:maps };
        let mut execution = RetainedProductExecution::begin(&job,&context,&options(),&mut decoder,&router).unwrap();
        while let Some(issued) = execution.issue_next(&mut decoder,&router,&worker).unwrap() {
            let receipt = issued.execute(&mut worker,0.001,15.,MeshLimits::default()).unwrap();
            assert!(!receipt.realizations()[0].construction().unwrap().completion().tessellation.indices.is_empty());
            execution.accept(receipt,&mut decoder,&router).unwrap_or_else(|e|panic!("{:?}",e.reason));
        }
        let witness = execution.into_witness().unwrap();
        witness.validate().unwrap();
        assert_eq!(witness.discharged_count(),count);
        assert_eq!(witness.plan().values.len(),count);
        for value in &witness.plan().values {
            assert_eq!(value.presentation().last().unwrap().type_product,Some((60,class)));
        }
        if count==2 {
            let a = witness.plan().values[0].world_from_source().unwrap();
            let b = witness.plan().values[1].world_from_source().unwrap();
            assert_eq!([a[12],a[13],a[14]],[10.,20.,30.]);
            assert_eq!([b[12],b[13],b[14]],[-4.,3.,2.]);
        }
    }
}
#[test]
fn h2a2_type_transaction_rejects_a_map_not_owned_by_the_actual_type_root() {
    let source = SourceBundle::new(SOURCE.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = router(&mut decoder);
    let context = ProductionModel::from_source(source.clone()).snapshot(Default::default());
    let entity = decoder.decode_by_id(60).unwrap();
    let metadata = metadata(60);
    let maps = vec![(12,1)];
    let mut job = job(&entity,&metadata);
    job.kind = ElementJobKind::TypeProduct { rep_maps:maps };
    assert!(matches!(RetainedProductExecution::begin(&job,&context,&options(),&mut decoder,&router),
        Err(RetainedExecutionError::Source)));
}
#[test]
fn h2a2_late_type_origin_failure_keeps_earlier_receipts_private_and_poisoned() {
    let Some(mut worker) = worker() else { return };
    let bytes = SOURCE.replace("#71=IFCREPRESENTATIONMAP(#17,#22)","#71=IFCREPRESENTATIONMAP(#999,#22)");
    let source = SourceBundle::new(bytes.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_units(&bytes,&mut decoder);
    let context = ProductionModel::from_source(source.clone()).snapshot(Default::default());
    let entity = decoder.decode_by_id(60).unwrap();
    let metadata = metadata(60);
    let maps = vec![(61,1),(71,1)];
    let mut job = job(&entity,&metadata);
    job.kind = ElementJobKind::TypeProduct { rep_maps:maps };
    let mut execution = RetainedProductExecution::begin(&job,&context,&options(),&mut decoder,&router).unwrap();
    let mut issued_count=0;
    loop {
        match execution.issue_next(&mut decoder,&router,&worker) {
            Ok(Some(issued)) => {
                issued_count+=1;
                let receipt = issued.execute(&mut worker,0.001,15.,MeshLimits::default()).unwrap();
                execution.accept(receipt,&mut decoder,&router).unwrap_or_else(|e|panic!("{:?}",e.reason));
            }
            Err(_) => break,
            Ok(None) => panic!("late malformed origin must refuse the whole type transaction"),
        }
    }
    assert_eq!(issued_count,2,"the original source precedes its late MappingOrigin");
    assert!(execution.traversal_plan().is_none());
    assert!(execution.validate_witness().is_err());
    assert!(execution.issue_next(&mut decoder,&router,&worker).is_err());
}
