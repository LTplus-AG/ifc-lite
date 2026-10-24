// SPDX-License-Identifier: MPL-2.0
//! #7955 completed bands, not uncut hosts, consume the fixed curved oracles.
use super::{BrowserWorker,receipt::BrowserReceipt};
use ifc_lite_core::{SourceBundle,EntityScanner};
use ifc_lite_geometry::{GeometryRouter,program::RetainedRequirement};
use ifc_lite_processing::{element::{ElementMeshJob,ElementJobKind,MeshProductionOptions,
    ProductionModel,OwnedMeshProductionData,RuntimeProductExecution,runtime::NumericalLimits},
    prepass::{resolve_prepass,PrepassSpans,ResolveOptions}};
use std::sync::Arc;
use wasm_bindgen_test::*;
#[path="../../../processing/src/element/session_retained/layer_oracles.rs"]
mod oracles;
#[wasm_bindgen_test(async)]
async fn j3_worker_completed_curved_bands_consume_fixed_net_volume_oracles() {
    let mut cases = oracles::cases();
    cases.push((oracles::mapped(),vec![]));
    for (text,expected) in cases {
        let bundle = SourceBundle::new(text.as_bytes().to_vec());
        let mut decoder = bundle.decoder();
        let mut router = GeometryRouter::with_units(&text,&mut decoder);
        router.set_rtc_offset((5_000_000.,-4_000_000.,0.));
        let model = ProductionModel::from_source(bundle.clone());
        let mut spans = PrepassSpans::default();
        let mut scanner = EntityScanner::new(&text);
        while let Some((id,ty,start,end)) = scanner.next_entity() {
            if ty=="IFCRELVOIDSELEMENT" { spans.void_rels.push((id,start,end)); }
        }
        let prepass = resolve_prepass(&spans,&mut decoder,ResolveOptions::default());
        let context = model.snapshot(OwnedMeshProductionData { void_index:Arc::new(prepass.void_index),..Default::default() });
        let entity = decoder.decode_by_id(10).unwrap();
        let job = ElementMeshJob { id:10,ifc_type:entity.ifc_type.clone(),entity:&entity,
            kind:ElementJobKind::Product,element_color:None,metadata:None };
        let mut worker = BrowserWorker::new().unwrap();
        worker.qualify_dependencies().await.unwrap();
        let mut execution = RuntimeProductExecution::<BrowserReceipt>::begin(&job,&context,&MeshProductionOptions::default(),&mut decoder,&router).unwrap();
        let limits = NumericalLimits { chord_metres:0.00001,angle_degrees:15.,max_bytes:16<<20 };
        while let Some(issued) = execution.issue_next(&mut decoder,&router,&worker).unwrap() {
            let completed = issued.execute_async(&mut worker,limits).await.unwrap();
            execution.accept(completed,&mut decoder,&router).unwrap_or_else(|r|panic!("{}",r.reason));
        }
        assert_eq!(execution.traversal_plan().unwrap().opening_completion.as_ref().unwrap().accepted_cuts(),1);
        if expected.is_empty() {
            assert!(execution.issue_layer_partition(&mut decoder,&router,&worker).is_err(),"J3_MAPPED_UNPROVED");
            continue;
        }
        let issued = execution.issue_layer_partition(&mut decoder,&router,&worker).unwrap();
        let completed = issued.execute_async(&mut worker,limits).await.unwrap();
        execution.accept_layer_partition(completed,&decoder,&router).unwrap();
        let witness = execution.into_witness().unwrap();
        let manifest = witness.layer_manifest().unwrap();
        assert_eq!(manifest.bands().len(),expected.len());
        for (i,(band,volume)) in manifest.bands().iter().zip(expected).enumerate() {
            let BrowserReceipt::Boolean(value) = band.receipt() else { panic!("J3 result kind") };
            assert!((super::product_tests::volume(&value.mesh)-volume).abs()<0.005,"J3_FIXED_NET_VOLUME band {i}");
            let source = manifest.binding(i).unwrap().source();
            let source_band = &source.bands()[i];
            if !band.is_empty() { oracles::assert_section(&value.mesh.positions,&value.world_from_left,source.world_from_product(),source_band.start_metres,source_band.end_metres); }
            assert_eq!(band.is_empty(),volume==0.,"J3_AUTHENTICATED_EMPTY");
            assert_eq!(manifest.binding(i).unwrap().source().bands()[i].ordinal,i);
        }
        assert!(!witness.plan().remaining.contains(&RetainedRequirement::MaterialLayers));
        assert!(witness.plan().remaining.contains(&RetainedRequirement::PersistentFaces));
        assert!(witness.require_final_product().is_err());
        assert!(!router.host_consumed_by_void(10));
        model.invalidate_source();
        assert!(witness.validate().is_err());
        worker.retire();
    }
}
