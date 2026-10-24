// SPDX-License-Identifier: MPL-2.0
//! #7955: source-derived opening stages through the actual Worker and shared controller.
use super::{BrowserWorker, BrowserCancellation};
use super::receipt::BrowserReceipt;
use super::opening_witness::*;
use ifc_lite_core::{EntityScanner, SourceBundle};
use ifc_lite_geometry::GeometryRouter;
use ifc_lite_processing::element::{ElementJobKind, ElementMeshJob, MeshProductionOptions,
    ProductionModel, OwnedMeshProductionData, RuntimeProductExecution, RetainedExecutionError,
    runtime::{AsyncRetainedExecutor, Invocation, NumericalLimits, RetainedRuntime}};
use ifc_lite_processing::prepass::{resolve_prepass, PrepassSpans, ResolveOptions};
use wasm_bindgen_test::*;
use std::sync::Arc;

struct Observed { worker: BrowserWorker, oracle: Option<super::opening_witness::analytic::Oracle>, cuts: usize, per_part: usize }
impl RetainedRuntime for Observed {
    type Receipt = BrowserReceipt;
    fn domain(&self) -> BrowserCancellation { self.worker.cancellation() }
    fn incarnation(&self) -> u64 { self.worker.incarnation() }
}
impl AsyncRetainedExecutor for Observed {
    async fn invoke(&mut self, call: Invocation<'_,Self::Receipt>, limits: NumericalLimits,
        resources: &ifc_lite_geometry::resource::OwnedResourceContext) -> Result<Self::Receipt,RetainedExecutionError> {
        let receipt = self.worker.invoke(call,limits,resources).await?;
        if let BrowserReceipt::Boolean(value) = &receipt {
            self.cuts += 1;
            if let Some(oracle) = &self.oracle {
            oracle.assert_stage(self.cuts, super::product_tests::volume(&value.mesh));
            if self.cuts % self.per_part == 0 {
                oracle.assert_mesh(&value.mesh.positions,&value.mesh.indices,&value.world_from_left);
            }
            }
        }
        Ok(receipt)
    }
}
#[wasm_bindgen_test(async)]
async fn j2_worker_ordered_overlapping_and_repeated_multipart_source_oracles() {
    // Keep the authored backtrack fixture in this target's source corpus. Its
    // positive runtime chain remains an explicit release obligation.
    assert!(SourceBundle::new(TRAP.as_bytes().to_vec()).decoder().decode_by_id(61273).is_ok());
    let _empty_source = empty_host_source();
    for (source,parts,cuts) in [(OVERLAP.to_owned(),1,3),(reference_source(),1,2),(repeated_mapped_source(),2,8),(translated_source(),1,3)] {
        let bundle = SourceBundle::new(source.as_bytes().to_vec());
        let mut decoder = bundle.decoder();
        let mut router = GeometryRouter::with_units(&source,&mut decoder);
        router.set_rtc_offset((8.,16.,0.));
        let model = ProductionModel::from_source(bundle.clone());
        let mut spans = PrepassSpans::default();
        let mut scanner = EntityScanner::new(&source);
        while let Some((id,ty,start,end)) = scanner.next_entity() {
            if ty == "IFCRELVOIDSELEMENT" { spans.void_rels.push((id,start,end)); }
        }
        let prepass = resolve_prepass(&spans,&mut decoder,ResolveOptions::default());
        let context = model.snapshot(OwnedMeshProductionData { void_index: Arc::new(prepass.void_index), ..Default::default() });
        let entity = decoder.decode_by_id(30).unwrap();
        let job = ElementMeshJob { id:30, ifc_type:entity.ifc_type.clone(), entity:&entity,
            kind:ElementJobKind::Product, element_color:None, metadata:None };
        let mut observed = Observed { worker:BrowserWorker::new().unwrap(), oracle:Some(oracle(&source)), cuts:0, per_part:cuts/parts };
        observed.worker.qualify_dependencies().await.unwrap();
        let mut execution = RuntimeProductExecution::<BrowserReceipt>::begin(&job,&context,&MeshProductionOptions::default(),&mut decoder,&router).unwrap();
        let limits = NumericalLimits { chord_metres:0.00001, angle_degrees:15., max_bytes:16 << 20 };
        while let Some(issued) = execution.issue_next(&mut decoder,&router,&observed).unwrap() {
            let work = issued.execute_async(&mut observed,limits).await.unwrap();
            execution.accept(work,&mut decoder,&router).unwrap_or_else(|r|panic!("{}",r.reason));
            assert!(!router.host_consumed_by_void(30),"J2_EFFECT_ISOLATION");
        }
        assert_eq!(observed.cuts,cuts);
        let witness = execution.into_witness().unwrap();
        assert_eq!(witness.plan().values.len(),parts);
        assert!(witness.require_final_product().is_err());
        model.invalidate_source();
        assert!(witness.validate().is_err());
        observed.worker.retire();
    }
}

#[wasm_bindgen_test(async)]
async fn j2_worker_cancellation_malformed_and_empty_keep_effects_provisional() {
    for case in 0..5 {
        let source = match case {
            2 => empty_host_source(),
            4 => OVERLAP.replace("'SweptSolid',(#46)","'SweptSolid',(#26)"),
            3 => OVERLAP.replace("'SweptSolid',(#66)","'SweptSolid',(#999)"),
            _ => OVERLAP.to_owned(),
        };
        let bundle = SourceBundle::new(source.as_bytes().to_vec());
        let mut decoder = bundle.decoder();
        let router = GeometryRouter::with_units(&source,&mut decoder);
        let model = ProductionModel::from_source(bundle.clone());
        let mut spans = PrepassSpans::default();
        let mut scanner = EntityScanner::new(&source);
        while let Some((id,ty,start,end)) = scanner.next_entity() {
            if ty == "IFCRELVOIDSELEMENT" { spans.void_rels.push((id,start,end)); }
        }
        let prepass = resolve_prepass(&spans,&mut decoder,ResolveOptions::default());
        let context = model.snapshot(OwnedMeshProductionData { void_index:Arc::new(prepass.void_index), ..Default::default() });
        let entity = decoder.decode_by_id(30).unwrap();
        let job = ElementMeshJob { id:30, ifc_type:entity.ifc_type.clone(), entity:&entity,
            kind:ElementJobKind::Product, element_color:None, metadata:None };
        let mut observed = Observed { worker:BrowserWorker::new().unwrap(),oracle:None,cuts:0,per_part:3 };
        observed.worker.qualify_dependencies().await.unwrap();
        let mut execution = RuntimeProductExecution::<BrowserReceipt>::begin(&job,&context,&MeshProductionOptions::default(),&mut decoder,&router).unwrap();
        let limits = NumericalLimits { chord_metres:0.00001,angle_degrees:15.,max_bytes:16 << 20 };
        let mut failed = false;
        for _ in 0..128 {
            match execution.issue_next(&mut decoder,&router,&observed) {
                Err(error) => {
                    if case == 2 || case == 4 { assert!(matches!(error,RetainedExecutionError::Unsupported(message) if message.contains("protection policy"))); }
                    failed = true; break;
                }
                Ok(None) => break,
                Ok(Some(issued)) => {
                    let work = issued.execute_async(&mut observed,limits).await.unwrap();
                    execution.accept(work,&mut decoder,&router).unwrap_or_else(|r|panic!("{}",r.reason));
                    assert!(!router.host_consumed_by_void(30),"J2_EFFECT_ISOLATION");
                    if case < 2 && observed.cuts == [1,3][case] { execution.cancel(); }
                }
            }
        }
        if case == 4 {
            assert!(!failed, "J2_REMOVAL_PERMITTED");
            assert!(execution.has_authenticated_opening_removal(), "J2_REMOVAL_PERMITTED");
            execution.validate_witness().unwrap();
        } else {
            assert!(failed,"transaction must refuse cancellation, malformed body, or unproved removal");
            assert!(execution.traversal_plan().is_none());
        }
        if case == 2 { assert!(decoder.get_cached(46).is_none(),"J2_EMPTY_LAZY"); }
        if case == 4 { assert!(decoder.get_cached(66).is_none(),"J2_EMPTY_LAZY"); }
        assert!(!router.host_consumed_by_void(30),"J2_EFFECT_ISOLATION");
        observed.worker.retire();
    }
}

// Deliberately unignored positive; pending the separate profile-region integration.
#[wasm_bindgen_test(async)]
async fn j2_worker_issue3641_positive_chain_requires_profile_region_integration() {
    // Keep the authored backtrack fixture in this target's source corpus. Its
    // positive runtime chain remains an explicit release obligation.
    assert!(SourceBundle::new(TRAP.as_bytes().to_vec()).decoder().decode_by_id(61273).is_ok());
    let _empty_source = empty_host_source();
    for (source,parts,cuts) in [(TRAP.to_owned(),1,3)] {
        let bundle = SourceBundle::new(source.as_bytes().to_vec());
        let mut decoder = bundle.decoder();
        let mut router = GeometryRouter::with_units(&source,&mut decoder);
        router.set_rtc_offset((8.,16.,0.));
        let model = ProductionModel::from_source(bundle.clone());
        let mut spans = PrepassSpans::default();
        let mut scanner = EntityScanner::new(&source);
        while let Some((id,ty,start,end)) = scanner.next_entity() {
            if ty == "IFCRELVOIDSELEMENT" { spans.void_rels.push((id,start,end)); }
        }
        let prepass = resolve_prepass(&spans,&mut decoder,ResolveOptions::default());
        let context = model.snapshot(OwnedMeshProductionData { void_index: Arc::new(prepass.void_index), ..Default::default() });
        let entity = decoder.decode_by_id(72209).unwrap();
        let job = ElementMeshJob { id:72209, ifc_type:entity.ifc_type.clone(), entity:&entity,
            kind:ElementJobKind::Product, element_color:None, metadata:None };
        let mut observed = Observed { worker:BrowserWorker::new().unwrap(), oracle:None, cuts:0, per_part:cuts/parts };
        observed.worker.qualify_dependencies().await.unwrap();
        let mut execution = RuntimeProductExecution::<BrowserReceipt>::begin(&job,&context,&MeshProductionOptions::default(),&mut decoder,&router).unwrap();
        let limits = NumericalLimits { chord_metres:0.00001, angle_degrees:15., max_bytes:16 << 20 };
        while let Some(issued) = execution.issue_next(&mut decoder,&router,&observed).unwrap() {
            let work = issued.execute_async(&mut observed,limits).await.unwrap();
            assert!(work.realizations().iter().all(|value| !value.is_empty()), "J2_3641_POSITIVE");
            execution.accept(work,&mut decoder,&router).unwrap_or_else(|r|panic!("{}",r.reason));
            assert!(!router.host_consumed_by_void(72209),"J2_EFFECT_ISOLATION");
        }
        assert_eq!(observed.cuts,cuts);
        let witness = execution.into_witness().unwrap();
        assert_eq!(witness.plan().values.len(),parts);
        assert!(witness.require_final_product().is_err());
        model.invalidate_source();
        assert!(witness.validate().is_err());
        observed.worker.retire();
    }
}

#[wasm_bindgen_test(async)]
async fn j2_worker_wrong_type_representation_sibling_aborts_entire_closure() {
    for (source, malformed, expected_cuts) in representation_sibling_sources() {
        let bundle = SourceBundle::new(source.as_bytes().to_vec());
        let mut decoder = bundle.decoder();
        let router = GeometryRouter::with_units(&source, &mut decoder);
        let model = ProductionModel::from_source(bundle.clone());
        let mut spans = PrepassSpans::default();
        let mut scanner = EntityScanner::new(&source);
        while let Some((id, ty, start, end)) = scanner.next_entity() {
            if ty == "IFCRELVOIDSELEMENT" { spans.void_rels.push((id, start, end)); }
        }
        let prepass = resolve_prepass(&spans, &mut decoder, ResolveOptions::default());
        let context = model.snapshot(OwnedMeshProductionData { void_index: Arc::new(prepass.void_index), ..Default::default() });
        let entity = decoder.decode_by_id(30).unwrap();
        let job = ElementMeshJob { id: 30, ifc_type: entity.ifc_type.clone(), entity: &entity,
            kind: ElementJobKind::Product, element_color: None, metadata: None };
        let mut observed = Observed { worker: BrowserWorker::new().unwrap(), oracle: Some(oracle(OVERLAP)), cuts: 0, per_part: 3 };
        observed.worker.qualify_dependencies().await.unwrap();
        let mut execution = RuntimeProductExecution::<BrowserReceipt>::begin(&job, &context, &MeshProductionOptions::default(), &mut decoder, &router).unwrap();
        let limits = NumericalLimits { chord_metres: 0.00001, angle_degrees: 15., max_bytes: 16 << 20 };
        let mut refusal = None;
        for _ in 0..128 {
            match execution.issue_next(&mut decoder, &router, &observed) {
                Err(error) => { refusal = Some(error); break; }
                Ok(None) => break,
                Ok(Some(issued)) => {
                    let work = issued.execute_async(&mut observed, limits).await.unwrap();
                    execution.accept(work, &mut decoder, &router).unwrap_or_else(|r| panic!("{}", r.reason));
                    assert!(!router.host_consumed_by_void(30), "J2_EFFECT_ISOLATION");
                }
            }
        }
        if malformed {
            assert!(matches!(refusal, Some(RetainedExecutionError::Protocol(ref message))
                if message.contains("wrong reached opening representation type")), "J2_REPRESENTATION_TYPE_REPORT: {refusal:?}");
            assert!(execution.traversal_plan().is_none(), "J2_NO_PARTIAL_CLOSURE");
            assert!(execution.validate_witness().is_err());
            assert!(execution.issue_next(&mut decoder, &router, &observed).is_err());
            assert!(execution.into_witness().is_err());
        } else {
            assert!(refusal.is_none(), "legitimate non-body sibling: {refusal:?}");
            let witness = execution.into_witness().unwrap();
            assert_eq!(witness.plan().values.len(), 1);
            assert_eq!(witness.plan().opening_completion.as_ref().unwrap().accepted_cuts(), 3);
            assert!(!witness.plan().remaining.contains(&ifc_lite_geometry::program::RetainedRequirement::OpeningClosure));
            witness.validate().unwrap();
            assert!(witness.require_final_product().is_err());
        }
        assert_eq!(observed.cuts, expected_cuts, "J2_REPRESENTATION_SIBLING_CUTS");
        assert!(!router.host_consumed_by_void(30), "J2_EFFECT_ISOLATION");
        observed.worker.retire();
    }
}

#[wasm_bindgen_test(async)]
async fn j2_worker_source_protected_whole_product_removal() {
    for (index, source) in removal_sources().into_iter().enumerate() {
        let parts = if index == 2 { 2 } else { 1 };
        let cuts = parts;
        let bundle = SourceBundle::new(source.as_bytes().to_vec());
        let mut decoder = bundle.decoder();
        let mut router = GeometryRouter::with_units(&source,&mut decoder);
        router.set_rtc_offset((8.,16.,0.));
        let model = ProductionModel::from_source(bundle.clone());
        let mut spans = PrepassSpans::default();
        let mut scanner = EntityScanner::new(&source);
        while let Some((id,ty,start,end)) = scanner.next_entity() {
            if ty == "IFCRELVOIDSELEMENT" { spans.void_rels.push((id,start,end)); }
        }
        let prepass = resolve_prepass(&spans,&mut decoder,ResolveOptions::default());
        let context = model.snapshot(OwnedMeshProductionData { void_index: Arc::new(prepass.void_index), ..Default::default() });
        let entity = decoder.decode_by_id(30).unwrap();
        let job = ElementMeshJob { id:30, ifc_type:entity.ifc_type.clone(), entity:&entity,
            kind:ElementJobKind::Product, element_color:None, metadata:None };
        let mut observed = Observed { worker:BrowserWorker::new().unwrap(), oracle:None, cuts:0, per_part:cuts/parts };
        observed.worker.qualify_dependencies().await.unwrap();
        let mut execution = RuntimeProductExecution::<BrowserReceipt>::begin(&job,&context,&MeshProductionOptions::default(),&mut decoder,&router).unwrap();
        let limits = NumericalLimits { chord_metres:0.00001, angle_degrees:15., max_bytes:16 << 20 };
        while let Some(issued) = execution.issue_next(&mut decoder,&router,&observed).expect("J2_REMOVAL_PERMITTED") {
            let work = issued.execute_async(&mut observed,limits).await.unwrap();
            execution.accept(work,&mut decoder,&router).unwrap_or_else(|r|panic!("{}",r.reason));
            assert!(!router.host_consumed_by_void(30),"J2_EFFECT_ISOLATION");
        }
        assert_eq!(observed.cuts,cuts);
        assert!(decoder.get_cached(66).is_none(), "J2_EMPTY_LAZY");
        assert!(execution.has_authenticated_opening_removal(), "J2_REMOVAL_PERMITTED");
        let witness = execution.into_witness().unwrap();
        assert_eq!(witness.plan().values.len(),parts);
        assert!(witness.plan().values.iter().all(|value| value.is_empty()));
        assert!(witness.has_authenticated_opening_removal(), "J2_REMOVAL_PERMITTED");
        assert!(witness.require_final_product().is_err());
        model.invalidate_source();
        assert!(witness.validate().is_err());
        assert!(!witness.has_authenticated_opening_removal());
        assert!(witness.require_final_product().is_err());
        assert!(!router.host_consumed_by_void(30), "J2_EFFECT_ISOLATION");
        observed.worker.retire();
    }
}
