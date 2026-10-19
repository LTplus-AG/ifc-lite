// SPDX-License-Identifier: MPL-2.0
//! P3 canonical installed-load consumer with actual private module Workers.
use super::*;
use wasm_bindgen_test::*;
wasm_bindgen_test_configure!(run_in_browser);
const SOURCE: &str = include_str!("../../../geometry/tests/fixtures/nested_mapped_item.ifc");
fn api() -> IfcAPI {
    let api=IfcAPI::new();api.set_source_bytes(SOURCE.as_bytes().to_vec());api.bind_source_model().unwrap();api
}
#[wasm_bindgen_test(async)]
async fn p3_canonical_snapshot_nested_mapping_witness_is_not_final_product_output() {
    let api=api();let mut product=api.admit_retained_product(35).unwrap();
    let mut executor=RetainedBrowserProductExecutor::new().unwrap();
    let cancellation=executor.cancellation();
    executor.qualify_numerical_routes().await.unwrap();
    let witness=product.execute(&mut executor,0.001,15.,8_388_608).await.unwrap();
    let witness:serde_json::Value=serde_wasm_bindgen::from_value(witness).unwrap();
    assert_eq!(witness["contract"],"common_product_transaction_only");
    assert_eq!(witness["product_id"],35);assert_eq!(witness["occurrences"],2);
    assert_eq!(witness["final_product_available"],false);
    let remaining=witness["remaining_requirements"].as_array().unwrap();
    for requirement in ["OpeningClosure","MaterialLayers","IfcAppearance","PersistentFaces"] {
        assert!(remaining.iter().any(|value|value.as_str()==Some(requirement)),"missing actual unresolved obligation {requirement}");
    }
    assert!(!remaining.iter().any(|value|value.as_str()==Some("ProductPlacement")),
        "actual late product placement is complete before this inspection witness");
    assert!(product.witness().is_ok());
    cancellation.cancel();assert!(product.witness().is_err(),"actual object-domain retirement invalidates held witness");
}
#[wasm_bindgen_test(async)]
async fn p3_canonical_source_replacement_expires_captured_snapshot_without_rebinding() {
    let api=api();let mut product=api.admit_retained_product(35).unwrap();
    let original=product.load.clone();
    api.set_source_bytes(SOURCE.as_bytes().to_vec());api.bind_source_model().unwrap();
    assert!(product.context.validate_source().is_err());
    let current=api.coherent_source.lock().unwrap().clone().unwrap();
    assert!(!Arc::ptr_eq(&original,&current));
    let mut executor=RetainedBrowserProductExecutor::new().unwrap();
    assert!(product.execute(&mut executor,0.001,15.,8_388_608).await.is_err());
    assert!(product.execution.is_none());assert!(product.router.is_some(),"expired source rejected before transaction admission");
}
#[wasm_bindgen_test(async)]
async fn p3_cancellation_captured_before_executor_async_borrow_prevents_startup() {
    let api=api();let mut product=api.admit_retained_product(35).unwrap();
    let mut executor=RetainedBrowserProductExecutor::new().unwrap();
    let cancellation=executor.cancellation();cancellation.cancel();
    assert!(product.execute(&mut executor,0.001,15.,8_388_608).await.is_err());
    assert!(product.witness().is_err());assert!(product.execution.is_none());
}


#[wasm_bindgen_test]
fn p3_canonical_retained_admission_uses_the_same_material_layer_toggle_policy_as_batches() {
    let layers="#100=IFCMATERIAL('A',$,$);
        #101=IFCMATERIALLAYER(#100,0.5,.F.,$,$,$,$);
        #102=IFCMATERIALLAYER(#100,0.5,.F.,$,$,$,$);
        #103=IFCMATERIALLAYERSET((#101,#102),'layers',$);
        #104=IFCMATERIALLAYERSETUSAGE(#103,.AXIS2.,.POSITIVE.,0.,$);
        #105=IFCRELASSOCIATESMATERIAL('material',$,$,$,(#35),#104);
";
    let source=SOURCE.replace("ENDSEC;\nEND-ISO-10303-21;",&format!("{layers}ENDSEC;\nEND-ISO-10303-21;"));
    for merge in [false,true] {
        let api=IfcAPI::new();api.set_source_bytes(source.as_bytes().to_vec());api.bind_source_model().unwrap();
        api.set_merge_layers(merge);
        let product=api.admit_retained_product(35).unwrap();
        let retained=product.router.as_ref().unwrap();
        assert_eq!(retained.is_material_layer_sliceable(35),!merge);
        let load=product.load.clone();let mut decoder=load.source.decoder();
        let actual_index=api.get_or_build_material_layer_index(load.source.bytes(),&mut decoder);
        assert!(actual_index.is_sliceable(35),"the real source contains two material layers in both modes");
        let mut batch_router=GeometryRouter::new();
        api.configure_product_material_layers(&mut batch_router,load.source.bytes(),&mut decoder);
        assert_eq!(batch_router.is_material_layer_sliceable(35),retained.is_material_layer_sliceable(35));
    }
}
