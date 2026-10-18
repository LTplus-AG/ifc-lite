// SPDX-License-Identifier: MPL-2.0
//! A late terminal fault cannot publish an earlier accepted type-map result.
use super::*;
use crate::element::session_tests::{SOURCE, Context, canonical, job, metadata, options, router};
use ifc_lite_core::IfcSchema;
use ifc_lite_geometry::{BoolFailure, ExtrudedAreaSolidProcessor, GeometryProcessor, TessellationQuality};
use ifc_lite_geometry::resource::{self, ExecutionAccount, ExecutionPolicy, ProgramStop};
use std::{cell::{Cell, RefCell}, rc::Rc};

struct LateStop {
    calls: Rc<RefCell<Vec<u32>>>,
    final_hooks: Rc<Cell<usize>>,
    final_stop: bool,
}
impl GeometryProcessor for LateStop {
    fn supported_types(&self) -> Vec<IfcType> { vec![IfcType::IfcExtrudedAreaSolid] }
    fn process(&self, entity: &DecodedEntity, decoder: &mut EntityDecoder,
        schema: &IfcSchema, quality: TessellationQuality) -> ifc_lite_geometry::Result<Mesh> {
        self.calls.borrow_mut().push(entity.id);
        let mesh = ExtrudedAreaSolidProcessor::new(schema.clone()).process(entity, decoder, schema, quality)?;
        if entity.id == 13 {
            assert!((ifc_lite_geometry::kernel::mesh_volume::mesh_volume(&mesh).abs() - 24.).abs() < 1e-6);
        }
        if entity.id == 23 && !self.final_stop {
            resource::stop(ProgramStop::Cancelled);
        }
        // The callback deliberately returns real geometry after signalling stop.
        Ok(mesh)
    }
    fn take_bool_failures(&self) -> Vec<BoolFailure> {
        self.final_hooks.set(self.final_hooks.get() + 1);
        if self.final_stop && self.final_hooks.get() == 1 { resource::stop(ProgramStop::Cancelled); }
        Vec::new()
    }
}

fn assert_empty(output: &ProducedElementMeshes) {
    assert!(output.meshes.is_empty());
    assert!(output.instance_occurrences.is_empty());
    assert!(output.geometry_hash.is_none() && output.geometry_volume.is_none());
    assert!(output.geometry_aabb.is_none() && output.geometry_closure.is_none());
    assert!(output.csg_failures.is_empty());
}

fn late_type_map(owned: bool, accounted: bool, final_stop: bool) {
    let source = SOURCE.replace("ENDSEC;END-ISO-10303-21;", "#80=IFCMAPPEDITEM(#85,#81);
#81=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#4,1.,$);
#85=IFCREPRESENTATIONMAP(#5,#86);
#86=IFCSHAPEREPRESENTATION(#2,'Body','SweptSolid',(#13,#4));
#87=IFCBOOLEANRESULT(.XOR.,#13,$);
ENDSEC;END-ISO-10303-21;");
    let mut decoder = EntityDecoder::new(&source);
    let mut router = router(&mut decoder);
    router.disable_content_dedup();
    let cache = GeometryRouter::new_mapped_item_cache();
    router.enable_shared_mapped_item_cache(cache.clone());
    let prior_item = decoder.decode_by_id(80).unwrap();
    assert!(!router.process_representation_item(&prior_item, &mut decoder).unwrap().is_empty());
    let prior = cache.lock().unwrap().get(&85).expect("actual completed mapped wall cache").clone();
    if final_stop {
        let boolean = decoder.decode_by_id(87).unwrap();
        assert!(!router.process_representation_item(&boolean, &mut decoder).unwrap().is_empty(),
            "diagnostic evidence comes from an actual unsupported Boolean operator");
    }
    let calls = Rc::new(RefCell::new(Vec::new()));
    let final_hooks = Rc::new(Cell::new(0));
    router.register(Box::new(LateStop { calls: calls.clone(), final_hooks: final_hooks.clone(), final_stop }));
    let entity = decoder.decode_by_id(60).unwrap();
    let metadata = metadata(60);
    let mut job = job(&entity, &metadata);
    job.kind = ElementJobKind::TypeProduct { rep_maps: plan_type_geometry(
        &[61, 71], &FxHashSet::default(), false, TypeGeometryMode::EmitTagged) };
    let context = ProductionModel::new().snapshot(OwnedMeshProductionData::default());
    if accounted {
        let account = ExecutionAccount::new(ExecutionPolicy::Compatibility);
        let output = produce_element_meshes_owned_accounted(&job, &context, &options(),
            &mut decoder, &router, &account);
        assert!(matches!(output, Err(AccountedProductionError::Stopped(ProgramStop::Cancelled))));
    } else if owned {
        assert_empty(&produce_element_meshes_owned(&job, &context, &options(), &mut decoder, &router).unwrap());
    } else {
        assert_empty(&produce_element_meshes(&job, &Context::default().borrowed(),
            &options(), &mut decoder, &router));
    }
    assert_eq!(*calls.borrow(), [13, 23], "both real maps are reached once; stop cannot retry geometry");
    assert_eq!(final_hooks.get(), usize::from(final_stop),
        "a prior stop must skip final hooks; a stop inside the final hook cannot publish geometry");
    assert!(std::sync::Arc::ptr_eq(cache.lock().unwrap().get(&85).unwrap(), &prior),
        "terminal output discard cannot retract independent completed cache effects");
    assert_eq!(router.take_unsupported_items().get("IfcCartesianPoint"), Some(&1),
        "earlier real source-loss evidence survives terminal output discard");
    assert!(decoder.try_execution_lease().is_ok());
    assert!(router.try_execution_lease().is_ok());
    assert!(resource::check_current().is_ok(), "ordinary Compatibility stop does not leak to the next product");
    if final_stop {
        let reports = router.take_csg_failures();
        assert_eq!(reports.len(), 1);
        assert_eq!(reports.get(&0), Some(&vec![ifc_lite_geometry::BoolFailure::new(
            ifc_lite_geometry::BoolOp::Unknown,
            ifc_lite_geometry::BoolFailureReason::UnknownBooleanOperator("XOR".into()))]),
            "restored diagnostics retain exact unattributed bucket, order and absent product identity");
        assert!(router.take_csg_failures().is_empty(), "restored evidence drains exactly once");
        let next = decoder.decode_by_id(20).unwrap();
        let next_metadata = crate::element::session_tests::metadata(20);
        let next_output = produce_element_meshes(&crate::element::session_tests::job(&next, &next_metadata),
            &Context::default().borrowed(), &options(), &mut decoder, &router);
        assert!(!next_output.meshes.is_empty());
        assert!(next_output.csg_failures.is_empty(), "subsequent product cannot inherit a fabricated attribution");
    }
}

#[test]
fn compatibility_late_type_map_stop_discards_prior_output_and_skips_final_hooks() {
    assert_eq!(canonical(60, true).meshes.len(), 2, "positive fixture produces both maps");
    for owned in [false, true] { late_type_map(owned, false, false); }
    late_type_map(true, true, false);
}

#[test]
fn compatibility_final_hook_stop_discards_completed_geometry_without_retry() {
    for owned in [false, true] { late_type_map(owned, false, true); }
    late_type_map(true, true, true);
}

#[test]
fn stopped_valid_reply_cannot_assemble_after_an_earlier_type_map_was_accepted() {
    let mut decoder = EntityDecoder::new(SOURCE);
    let mut router = router(&mut decoder);
    router.disable_content_dedup();
    let calls = Rc::new(RefCell::new(Vec::new()));
    let final_hooks = Rc::new(Cell::new(0));
    // Both numerical maps succeed; cancellation is reached before accepting
    // the second legitimate reply, not inside a fabricated geometry callback.
    router.register(Box::new(LateStop { calls: calls.clone(), final_hooks: final_hooks.clone(), final_stop: true }));
    let entity = decoder.decode_by_id(60).unwrap();
    let metadata = metadata(60);
    let mut job = job(&entity, &metadata);
    job.kind = ElementJobKind::TypeProduct { rep_maps: plan_type_geometry(
        &[61, 71], &FxHashSet::default(), false, TypeGeometryMode::EmitTagged) };
    let context = ProductionModel::new().snapshot(OwnedMeshProductionData::default());
    let mut execution = crate::element::owned_session::OwnedProductExecution::new(
        &job, &context, &options(), &mut decoder, &router).unwrap();
    assert!(execution.advance(&mut decoder, &router).unwrap());
    assert_eq!(execution.state.meshes.len(), 1, "the first real map was already presented");
    assert!(!execution.state.meshes[0].positions.is_empty());
    let request = execution.request().unwrap().unwrap();
    let reply = execution.execute(request, &mut decoder, &router).unwrap();
    let account = ExecutionAccount::new(ExecutionPolicy::Compatibility);
    account.scope(|| {
        resource::stop(ProgramStop::Cancelled);
        execution.accept(reply, &mut decoder, &router).unwrap();
    });
    assert!(execution.request().unwrap().is_none());
    assert_empty(&execution.finish(&decoder, &router).unwrap());
    assert_eq!(*calls.borrow(), [13, 23]);
    assert_eq!(final_hooks.get(), 0);
    assert!(decoder.try_execution_lease().is_ok());
    assert!(router.try_execution_lease().is_ok());
    assert!(resource::check_current().is_ok());
}

#[test]
fn compatibility_terminal_is_owned_before_private_planning_epoch_can_replace_its_scope() {
    let mut decoder = EntityDecoder::new(SOURCE);
    let mut router = router(&mut decoder);
    let calls = Rc::new(RefCell::new(Vec::new()));
    let final_hooks = Rc::new(Cell::new(0));
    router.register(Box::new(LateStop { calls: calls.clone(), final_hooks: final_hooks.clone(), final_stop: false }));
    let entity = decoder.decode_by_id(60).unwrap();
    let metadata = metadata(60);
    let mut job = job(&entity, &metadata);
    job.kind = ElementJobKind::TypeProduct { rep_maps: plan_type_geometry(
        &[61, 71], &FxHashSet::default(), false, TypeGeometryMode::EmitTagged) };
    let context = ProductionModel::new().snapshot(OwnedMeshProductionData::default());
    let account = ExecutionAccount::new(ExecutionPolicy::Compatibility);
    let mut execution = account.scope(|| {
        resource::stop(ProgramStop::Cancelled);
        crate::element::owned_session::OwnedProductExecution::new(&job, &context,
            &options(), &mut decoder, &router).unwrap()
    });
    assert!(execution.request().unwrap().is_none());
    assert_empty(&execution.finish(&decoder, &router).unwrap());
    assert!(calls.borrow().is_empty(), "pre-stopped planning cannot request real geometry");
    assert_eq!(final_hooks.get(), 0);
    assert!(decoder.try_execution_lease().is_ok());
    assert!(router.try_execution_lease().is_ok());
    assert!(resource::check_current().is_ok());
}
