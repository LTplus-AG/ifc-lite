// SPDX-License-Identifier: MPL-2.0
//! #7955: actual runtime host remains explicitly pending J3 after source admission.
use super::*;
use ifc_lite_core::SourceBundle;
const SOURCE: &str = include_str!("../../../../../tests/evidence/retained-layers-j3/circular-slab.ifc");
#[test]
fn j3_sdk_curved_host_keeps_source_bands_without_claiming_partition() {
    let Some(mut worker) = super::tests::worker() else { return };
    let source = SourceBundle::new(SOURCE.as_bytes().to_vec());
    let mut decoder = source.decoder();
    let mut router = GeometryRouter::with_units(SOURCE,&mut decoder);
    router.set_rtc_offset((5_000_000.,-4_000_000.,0.));
    let model = ProductionModel::from_source(source.clone());
    let context = model.snapshot(Default::default());
    let entity = decoder.decode_by_id(10).unwrap();
    let job = ElementMeshJob { id:10,ifc_type:entity.ifc_type.clone(),entity:&entity,
        kind:ElementJobKind::Product,element_color:None,metadata:None };
    let mut execution = RetainedProductExecution::begin(&job,&context,&MeshProductionOptions::default(),&mut decoder,&router).unwrap();
    let mut constructions = 0;
    while let Some(issued) = execution.issue_next(&mut decoder,&router,&worker).unwrap() {
        let completed = issued.execute(&mut worker,0.00001,15.,MeshLimits::default()).unwrap();
        constructions += completed.realizations.len();
        execution.accept(completed,&mut decoder,&router).unwrap_or_else(|r|panic!("{}",r.reason));
    }
    assert_eq!(constructions,1,"source binding must not invent numeric cutters");
    let witness = execution.into_witness().unwrap();
    let layers = witness.layer_source().unwrap();
    assert_eq!(layers.bands().iter().map(|b|(b.start_metres,b.end_metres)).collect::<Vec<_>>(),
        [(0.,0.5),(0.5,1.5),(1.5,3.)],"J3_RUNTIME_SOURCE");
    assert!(witness.plan().remaining.contains(&RetainedRequirement::MaterialLayers),"J3_UNMET_PARTITION");
    assert!(witness.plan().remaining.contains(&RetainedRequirement::PersistentFaces));
    assert!(witness.require_final_product().is_err());
    model.invalidate_source();
    assert!(witness.validate().is_err());
}
