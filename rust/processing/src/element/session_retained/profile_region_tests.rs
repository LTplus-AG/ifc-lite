// SPDX-License-Identifier: MPL-2.0
use super::*;
use ifc_lite_core::SourceBundle;
#[path = "../../../tests/support/profile_region_witness.rs"]
mod oracle;

#[test]
fn issue_3641_native_original_source_construction_oracle() {
    let Some(mut worker) = super::tests::worker() else { return };
    worker.qualify_ordered_regions().unwrap();
    for rtc in [(0.,0.,0.), (1e6,-2e6,3e6)] {
        let source = SourceBundle::new(oracle::FIXTURE.to_vec());
        let mut decoder = source.decoder().with_strict_reals();
        let mut router = GeometryRouter::with_units(source.bytes(), &mut decoder);
        router.set_rtc_offset(rtc);
        let model = ProductionModel::from_source(source.clone());
        let context = model.snapshot(Default::default());
        // The unchanged authored feature, not the slab's three-cut transaction.
        let entity = decoder.decode_by_id(72245).unwrap();
        let job = ElementMeshJob { id: entity.id, ifc_type: entity.ifc_type.clone(), entity: &entity,
            kind: ElementJobKind::Product, element_color: None, metadata: None };
        let mut execution = RetainedProductExecution::begin(&job, &context, &MeshProductionOptions::default(), &mut decoder, &router).unwrap();
        let issued = execution.issue_next(&mut decoder, &router, &worker).unwrap().unwrap();
        let completed = issued.execute(&mut worker, 0.001, 5., MeshLimits::default()).unwrap();
        let result = completed.realizations()[0].construction().unwrap();
        oracle::check(result.completion());
        let volume = worker.volume(result.solid(),1e-8).unwrap();
        assert!((volume-oracle::VOLUME).abs() <= 1e-6, "REGION_NATIVE_VOLUME");
        execution.accept(completed, &mut decoder, &router).unwrap_or_else(|e| panic!("{}",e.reason));
        assert!(execution.issue_next(&mut decoder, &router, &worker).unwrap().is_none());
        let witness = execution.into_witness().unwrap();
        witness.validate().unwrap();
        assert!(!witness.plan().remaining.is_empty(), "source admission cannot publish final geometry");
        model.invalidate_source();
        assert!(witness.validate().is_err());
    }
}
