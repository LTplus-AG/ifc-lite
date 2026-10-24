// SPDX-License-Identifier: MPL-2.0
//! #7955 actual J2 net-host followed by complete capped J3 bands.
use super::*;
use ifc_lite_core::{SourceBundle,EntityScanner};
use crate::prepass::{resolve_prepass,PrepassSpans,ResolveOptions};
use runtime::NumericalLimits;
pub(super) fn with_source(text:&str, f:impl FnOnce(&mut RetainedProductExecution,&mut EntityDecoder,&GeometryRouter)) {
    let source = SourceBundle::new(text.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let mut router = GeometryRouter::with_units(text,&mut decoder);
    router.set_rtc_offset((5_000_000.,-4_000_000.,0.));
    let model = ProductionModel::from_source(source.clone());
    let mut spans = PrepassSpans::default();
    let mut scanner = EntityScanner::new(text);
    while let Some((id,ty,start,end)) = scanner.next_entity() {
        if ty=="IFCRELVOIDSELEMENT" { spans.void_rels.push((id,start,end)); }
    }
    let prepass = resolve_prepass(&spans,&mut decoder,ResolveOptions::default());
    let context = model.snapshot(OwnedMeshProductionData { void_index:Arc::new(prepass.void_index),..Default::default() });
    let entity = decoder.decode_by_id(10).unwrap();
    let job = ElementMeshJob { id:10,ifc_type:entity.ifc_type.clone(),entity:&entity,
        kind:ElementJobKind::Product,element_color:None,metadata:None };
    let mut execution = RetainedProductExecution::begin(&job,&context,&MeshProductionOptions::default(),&mut decoder,&router).unwrap();
    f(&mut execution,&mut decoder,&router);
}
pub(super) fn host(execution:&mut RetainedProductExecution,decoder:&mut EntityDecoder,router:&GeometryRouter,worker:&mut SmlibWorker) {
    while let Some(issued) = execution.issue_next(decoder,router,worker).unwrap() {
        let completed = issued.execute(worker,0.00001,15.,MeshLimits::default()).unwrap();
        execution.accept(completed,decoder,router).unwrap_or_else(|r|panic!("{}",r.reason));
    }
    assert_eq!(execution.traversal_plan().unwrap().opening_completion.as_ref().unwrap().accepted_cuts(),1);
}
pub(super) fn limits() -> NumericalLimits { NumericalLimits { chord_metres:0.00001,angle_degrees:15.,max_bytes:16<<20 } }
#[test]
fn j3_sdk_completed_curved_bands_consume_fixed_net_volume_oracles() {
    let Some(mut worker) = tests::worker() else { return };
    worker.qualify_ordered_regions().unwrap();
    for (source,expected) in layer_oracles::cases() {
        with_source(&source,|execution,decoder,router| {
            host(execution,decoder,router,&mut worker);
            let packet = execution.issue_layer_partition(decoder,router,&worker).unwrap();
            let completed = packet.execute(&mut worker,limits()).unwrap();
            execution.accept_layer_partition(completed,decoder,router).unwrap();
            let manifest = execution.layer_manifest.as_ref().unwrap();
            assert_eq!(manifest.bands().len(),expected.len(),"J3_PARTIAL_COMMIT");
            for (i,(band,volume)) in manifest.bands().iter().zip(expected).enumerate() {
                let RealizationKind::Boolean(value) = band.receipt() else { panic!("J3 result kind") };
                let actual = if band.is_empty() { 0. } else { worker.volume(value.solid(),1e-8).unwrap() };
                assert!((actual-volume).abs()<1e-6,"J3_FIXED_NET_VOLUME band {i}");
                let source = manifest.binding(i).unwrap().source();
                let source_band = &source.bands()[i];
                if !band.is_empty() { layer_oracles::assert_section(&value.mesh().positions,value.world_from_evaluation(),source.world_from_product(),source_band.start_metres,source_band.end_metres); }
                assert_eq!(band.is_empty(),volume==0.,"J3_AUTHENTICATED_EMPTY");
                assert_eq!(manifest.binding(i).unwrap().source().bands()[i].ordinal,i);
            }
            assert!(!execution.traversal_plan().unwrap().remaining.contains(&RetainedRequirement::MaterialLayers));
            assert!(execution.traversal_plan().unwrap().remaining.contains(&RetainedRequirement::PersistentFaces));
            assert!(!router.host_consumed_by_void(10));
        });
    }
    with_source(&layer_oracles::mapped(),|execution,decoder,router| {
        host(execution,decoder,router,&mut worker);
        assert!(execution.issue_layer_partition(decoder,router,&worker).is_err(),"J3_MAPPED_UNPROVED");
        assert!(execution.layer_manifest.is_none());
    });
}
#[test]
fn j3_sdk_foreign_issuance_never_commits_bands() {
    let Some(mut worker) = tests::worker() else { return };
    worker.qualify_ordered_regions().unwrap();
    with_source(layer_oracles::TWO,|left,decoder,router| {
        host(left,decoder,router,&mut worker);
        let pending = left.issue_layer_partition(decoder,router,&worker).unwrap();
        with_source(layer_oracles::TWO,|right,d,r| {
            host(right,d,r,&mut worker);
            let completed = right.issue_layer_partition(d,r,&worker).unwrap().execute(&mut worker,limits()).unwrap();
            assert!(left.accept_layer_partition(completed,decoder,router).is_err(),"J3_AUTHORITY");
            assert!(left.layer_manifest.is_none());
        });
        // Keep the legitimate packet alive until the foreign receipt was tested.
        let completed = pending.execute(&mut worker,limits()).unwrap();
        left.accept_layer_partition(completed,decoder,router).unwrap();
    });
}
