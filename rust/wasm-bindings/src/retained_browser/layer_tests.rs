// SPDX-License-Identifier: MPL-2.0
//! #7955: actual Worker host + shared J3 source binding; partition is still unmet.
use super::{BrowserWorker, receipt::BrowserReceipt};
use ifc_lite_core::SourceBundle;
use ifc_lite_geometry::{GeometryRouter, program::RetainedRequirement};
use ifc_lite_processing::element::{ElementJobKind,ElementMeshJob,MeshProductionOptions,
    ProductionModel,RuntimeProductExecution,runtime::NumericalLimits};
use wasm_bindgen_test::*;
const SOURCE: &str = include_str!("../../../../tests/evidence/retained-layers-j3/circular-slab.ifc");
#[wasm_bindgen_test(async)]
async fn j3_worker_curved_host_keeps_source_bands_without_claiming_partition() {
    let source = SourceBundle::new(SOURCE.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let mut router = GeometryRouter::with_units(SOURCE,&mut decoder);
    router.set_rtc_offset((5_000_000.,-4_000_000.,0.));
    let model = ProductionModel::from_source(source.clone());
    let context = model.snapshot(Default::default());
    let entity = decoder.decode_by_id(10).unwrap();
    let job = ElementMeshJob { id:10,ifc_type:entity.ifc_type.clone(),entity:&entity,
        kind:ElementJobKind::Product,element_color:None,metadata:None };
    let mut worker = BrowserWorker::new().unwrap();
    let mut execution = RuntimeProductExecution::<BrowserReceipt>::begin(&job,&context,
        &MeshProductionOptions::default(),&mut decoder,&router).unwrap();
    let limits = NumericalLimits { chord_metres:0.00001,angle_degrees:15.,max_bytes:16 << 20 };
    let mut packets = 0;
    while let Some(issued) = execution.issue_next(&mut decoder,&router,&worker).unwrap() {
        let completed = issued.execute_async(&mut worker,limits).await.unwrap();
        execution.accept(completed,&mut decoder,&router).unwrap_or_else(|r|panic!("{}",r.reason));
        packets += 1;
    }
    assert_eq!(packets,1);
    let witness = execution.into_witness().unwrap();
    assert_eq!(witness.layer_source().unwrap().bands().iter()
        .map(|b|(b.start_metres,b.end_metres)).collect::<Vec<_>>(),
        [(0.,0.5),(0.5,1.5),(1.5,3.)]);
    assert!(witness.plan().remaining.contains(&RetainedRequirement::MaterialLayers));
    assert!(witness.require_final_product().is_err());
    model.invalidate_source();
    assert!(witness.validate().is_err());
    worker.retire();
}
