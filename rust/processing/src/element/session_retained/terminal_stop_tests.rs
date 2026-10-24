// SPDX-License-Identifier: MPL-2.0
//! #7955 finalization under the original lifecycle/account; no ambient rescue.
use super::*;
use ifc_lite_core::{EntityScanner,SourceBundle};
use crate::prepass::{PrepassSpans,resolve_prepass,ResolveOptions};
fn fixture(f: impl FnOnce(&mut RetainedProductExecution,&mut EntityDecoder,&GeometryRouter,&ProductionModel)) {
    fixture_mode(0,f);
}
fn fixture_mode(mode: u8, f: impl FnOnce(&mut RetainedProductExecution,&mut EntityDecoder,&GeometryRouter,&ProductionModel)) {
    let source = SourceBundle::new(super::opening_witness::removal_sources().remove(0).into_bytes());
    let mut decoder = source.decoder();
    let mut router = GeometryRouter::with_units(source.bytes(),&mut decoder);
    let model = ProductionModel::from_source(source.clone());
    if mode != 0 { router.register(Box::new(FinalHook { mode, model:model.clone() })); }
    let mut spans = PrepassSpans::default();
    let mut scanner = EntityScanner::new(source.bytes());
    while let Some((id,name,start,end)) = scanner.next_entity() {
        if ifc_lite_core::keyword_eq(name,"IFCRELVOIDSELEMENT") { spans.void_rels.push((id,start,end)); }
    }
    let prepass = resolve_prepass(&spans,&mut decoder,ResolveOptions::default());
    let context = model.snapshot(OwnedMeshProductionData { void_index: Arc::new(prepass.void_index),..Default::default() });
    let entity = decoder.decode_by_id(30).unwrap();
    let job = ElementMeshJob {id:30,ifc_type:entity.ifc_type.clone(),entity:&entity,
        kind:ElementJobKind::Product,element_color:None,metadata:None};
    let mut execution = RetainedProductExecution::begin(&job,&context,&MeshProductionOptions::default(),&mut decoder,&router).unwrap();
    f(&mut execution,&mut decoder,&router,&model);
    let committed = router.host_consumed_by_void(30);
    drop(execution);
    assert_eq!(router.host_consumed_by_void(30),committed,"J2_TERMINAL_DROP");
}
#[test]
fn j2_terminal_stale_and_original_resource_stops() {
    let Some(mut worker) = super::tests::worker() else { return };
    for mode in 0..3 {
        let account = resource::ExecutionAccount::new(resource::ExecutionPolicy::Bounded(resource::ResourceLimits {
            work:Some(100_000_000),..Default::default() }));
        account.scope(|| fixture(|execution,decoder,router,model| {
            super::terminal_tests::complete(execution,decoder,router,&mut worker);
            match mode {
                0 => model.invalidate_source(),
                1 => account.cancel(),
                _ => { execution.resources.charge(resource::Cost {work:100_000_000-account.usage().work,
                    ..Default::default()}).unwrap().retain(); },
            }
            let result = execution.publish_removed(decoder,router,&worker);
            assert!(result.is_err(),"J2_TERMINAL_STOP");
            assert!(!router.host_consumed_by_void(30),"J2_TERMINAL_ISOLATION");
        }));
    }
}
#[test]
fn j2_terminal_owner_commit_rejection_has_no_effect() {
    // Actual ProductOwner commit fails AFTER the callback returned success.
    // This is the same primitive used by publish_removed, not an injected flag.
    let source = SourceBundle::new(super::opening_witness::removal_sources().remove(0).into_bytes());
    let mut decoder = source.decoder();
    let router = GeometryRouter::new();
    let mut owner = ProductOwner::admit(&decoder,&router).unwrap();
    let resources = OwnedResourceContext::capture_current();
    let result = router.commit_removed_host(30,&resources,|| {
        owner.work(&mut decoder,&router,|decoder,_| { *decoder = source.decoder(); })
    });
    assert!(result.is_err(),"J2_TERMINAL_OWNER_COMMIT");
    assert!(!router.host_consumed_by_void(30),"J2_TERMINAL_ATOMIC");
}
#[test]
fn j2_terminal_retired_worker_and_drop_have_no_effect() {
    for retire in [false,true] {
        let Some(mut worker) = super::tests::worker() else { return };
        fixture(|execution,decoder,router,_| {
            super::terminal_tests::complete(execution,decoder,router,&mut worker);
            if retire {
                worker.terminate().unwrap();
                assert!(execution.publish_removed(decoder,router,&worker).is_err(),"J2_TERMINAL_RETIRED");
            }
            assert!(!router.host_consumed_by_void(30),"J2_TERMINAL_DROP");
        });
    }
}

struct FinalHook { mode:u8, model:ProductionModel }
impl ifc_lite_geometry::GeometryProcessor for FinalHook {
    fn supported_types(&self) -> Vec<IfcType> { vec![IfcType::IfcCircle] }
    fn process(&self, _: &DecodedEntity, _: &mut EntityDecoder, _: &ifc_lite_core::IfcSchema,
        _: ifc_lite_geometry::TessellationQuality) -> ifc_lite_geometry::Result<Mesh> {
        panic!("terminal test has no circle construction")
    }
    fn take_bool_failures(&self) -> Vec<BoolFailure> {
        match self.mode {
            1 => { resource::stop(ProgramStop::Cancelled); },
            2 => self.model.invalidate_source(),
            _ => panic!("J2 final hook unwind"),
        }
        Vec::new()
    }
}
#[test]
fn j2_terminal_late_hook_stop_source_and_unwind_do_not_publish() {
    let Some(mut worker) = super::tests::worker() else { return };
    for mode in 1..=3 {
        fixture_mode(mode,|execution,decoder,router,_| {
            super::terminal_tests::complete(execution,decoder,router,&mut worker);
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(||
                execution.publish_removed(decoder,router,&worker)));
            if mode==3 { assert!(result.is_err()); }
            else { assert!(result.unwrap().is_err(),"J2_TERMINAL_LATE"); }
            assert!(!router.host_consumed_by_void(30),"J2_TERMINAL_LATE_EFFECT");
            assert!(execution.publish_removed(decoder,router,&worker).is_err(),"J2_TERMINAL_NO_RETRY");
        });
    }
}
