// SPDX-License-Identifier: MPL-2.0
//! Real canonical IFC production is the invariant, not a setter/counter echo.
use super::*;
use super::session_tests::{SOURCE, assert_same, canonical, job, metadata, options, router};
use ifc_lite_core::IfcSchema;
use ifc_lite_geometry::{ExtrudedAreaSolidProcessor, GeometryProcessor, TessellationQuality};
use ifc_lite_geometry::resource::{self, Cost, ExecutionAccount, ExecutionPolicy, ResourceLimits, ProgramStop};
use std::{cell::Cell, rc::Rc};

// Content-dedup storage is an explicit unsupported coverage domain. These
// admitted runs select a router without it; the parity oracle keeps defaults.
pub(super) fn admitted_router(decoder: &mut EntityDecoder) -> GeometryRouter {
    let mut router = router(decoder);
    router.disable_content_dedup();
    router
}

pub(super) fn account(limits: ResourceLimits) -> ExecutionAccount {
    ExecutionAccount::new(ExecutionPolicy::Bounded(limits))
}

#[test]
fn admitted_native_owned_adapter_preserves_actual_ordered_mesh_frame_metadata_and_fingerprint() {
    let model = ProductionModel::new();
    let context = model.snapshot(OwnedMeshProductionData::default());
    let mut decoder = EntityDecoder::new(SOURCE);
    let router = admitted_router(&mut decoder);
    let entity = decoder.decode_by_id(10).unwrap();
    let account = account(ResourceLimits::default());
    let output = produce_element_meshes_owned_accounted(&job(&entity,&metadata(10)), &context,
        &options(), &mut decoder, &router, &account).unwrap();
    assert_same(output.output(), &canonical(10,false));
    assert!(!output.is_resource_qualified(), "opaque producer/assembly work is explicit");
    let with_output = account.usage();
    assert!(with_output.output_bytes > 0 && with_output.live_bytes > 0);
    drop(output);
    assert!(account.usage().live_bytes < with_output.live_bytes,
        "the real output lease releases admitted output backing on drop");
    assert_eq!(account.usage().output_bytes, with_output.output_bytes,
        "dropping output never refunds cumulative publication allowance");
}

struct CatchStop { calls: Rc<Cell<usize>>, cancel: bool }
impl GeometryProcessor for CatchStop {
    fn supported_types(&self) -> Vec<IfcType> { vec![IfcType::IfcExtrudedAreaSolid] }
    fn process(&self, entity: &DecodedEntity, decoder: &mut EntityDecoder, schema: &IfcSchema,
        quality: TessellationQuality) -> ifc_lite_geometry::Result<Mesh> {
        self.calls.set(self.calls.get()+1);
        if self.cancel { resource::current_account().unwrap().cancel(); }
        else {
            // Deliberately swallow a typed refusal and then return real geometry.
            let _caught = resource::charge(Cost { copy_bytes: 1, ..Cost::default() });
        }
        ExtrudedAreaSolidProcessor::new(schema.clone()).process(entity,decoder,schema,quality)
    }
}

#[test]
fn caught_extension_refusal_or_cancellation_cannot_publish_or_retry_real_geometry() {
    for cancel in [false,true] {
        let model = ProductionModel::new();
        let context = model.snapshot(OwnedMeshProductionData::default());
        let mut decoder = EntityDecoder::new(SOURCE);
        let mut router = admitted_router(&mut decoder);
        let calls = Rc::new(Cell::new(0));
        router.register(Box::new(CatchStop { calls:calls.clone(), cancel }));
        let entity = decoder.decode_by_id(10).unwrap();
        let account = account(ResourceLimits { copy_bytes:Some(0), ..ResourceLimits::default() });
        let result = produce_element_meshes_owned_accounted(&job(&entity,&metadata(10)), &context,
            &options(), &mut decoder, &router, &account);
        let stop = match result { Err(AccountedProductionError::Stopped(stop)) => stop,
            _ => panic!("a swallowed terminal fault must remain terminal") };
        assert_eq!(stop == ProgramStop::Cancelled, cancel);
        assert_eq!(calls.get(),1,"terminal primary cannot enter void/plain retries");
        assert!(decoder.try_execution_lease().is_ok());
        assert!(router.try_execution_lease().is_ok());
        assert!(resource::current_account().is_none(),"TLS restored after typed failure");
    }
}

#[test]
fn zero_output_allowance_refuses_before_presentation_and_zero_work_before_processor() {
    for no_work in [false,true] {
        let model = ProductionModel::new();
        let context = model.snapshot(OwnedMeshProductionData::default());
        let mut decoder = EntityDecoder::new(SOURCE);
        let router = admitted_router(&mut decoder);
        let entity = decoder.decode_by_id(10).unwrap();
        let account = account(ResourceLimits { work:no_work.then_some(0),
            output_bytes:(!no_work).then_some(0), ..ResourceLimits::default() });
        assert!(matches!(produce_element_meshes_owned_accounted(&job(&entity,&metadata(10)),
            &context,&options(),&mut decoder,&router,&account),Err(AccountedProductionError::Stopped(_))));
        assert_eq!(account.usage().output_bytes,0,"rejected output never enters presentation");
        assert!(resource::current_account().is_none());
    }
}

#[test]
fn every_recoverable_work_kind_preserves_a_typed_stop_instead_of_empty_retry() {
    use super::plan::PrimaryStrategy;
    use super::session_protocol::WorkKind;
    use super::session_state::Stage;
    let kinds = [
        WorkKind::Primary { strategy:PrimaryStrategy::TexturedSubmeshes, layer_class:0 },
        WorkKind::Primary { strategy:PrimaryStrategy::VoidedSubmeshes, layer_class:0 },
        WorkKind::VoidedParts, WorkKind::PlainParts, WorkKind::TypeMap { map_id:61, class:1 },
    ];
    for kind in kinds {
        let source = SOURCE.replace("ENDSEC;END-ISO-10303-21;",
            "#200=IFCOPENINGELEMENT('opening',$,$,$,$,#19,#21,$,$);ENDSEC;END-ISO-10303-21;");
        let mut decoder = EntityDecoder::new(&source);
        let mut router = admitted_router(&mut decoder);
        let calls = Rc::new(Cell::new(0));
        router.register(Box::new(CatchStop { calls:calls.clone(), cancel:true }));
        let entity = decoder.decode_by_id(10).unwrap();
        let context = super::session_tests::Context::default();
        let openings = [(10, vec![200])].into_iter().collect();
        let mut borrowed = context.borrowed();
        borrowed.void_index = &openings;
        let account = account(ResourceLimits::default());
        let output = account.scope(|| {
            let mut state = super::session::ProductState::new(&job(&entity,&metadata(10)),
                &borrowed,&options(),&mut decoder,&router);
            // Enter each genuine coarse recovery boundary; all reached source,
            // selected callback, inner accepts and terminal finalization remain
            // the canonical session implementation.
            state.stage = match kind {
                WorkKind::Primary { strategy, layer_class } => Stage::Primary { strategy, layer_class },
                WorkKind::VoidedParts => Stage::VoidedParts,
                WorkKind::PlainParts => Stage::PlainParts,
                WorkKind::TypeMap { map_id, class } => Stage::TypeMaps(vec![(map_id,class)].into_iter()),
            };
            while let Some(request) = state.request().unwrap() {
                assert_eq!(request.kind,kind,"terminal work cannot enter a later recovery strategy");
                let reply = state.execute(request,&borrowed,&mut decoder,&router).unwrap();
                state.accept(reply,&borrowed,&mut decoder,&router).unwrap();
            }
            state.finish(&decoder,&router)
        });
        assert_eq!(account.check(),Err(ProgramStop::Cancelled),"{kind:?}");
        assert!(output.meshes.is_empty() && output.instance_occurrences.is_empty(),"{kind:?}");
        assert!(output.geometry_hash.is_none() && output.geometry_volume.is_none(),"{kind:?}");
        assert_eq!(calls.get(),1,"a terminal callback is never reentered by recovery");
    }
}

struct PanicProcessor;
impl GeometryProcessor for PanicProcessor {
    fn supported_types(&self) -> Vec<IfcType> { vec![IfcType::IfcExtrudedAreaSolid] }
    fn process(&self,_:&DecodedEntity,_:&mut EntityDecoder,_:&IfcSchema,
        _:TessellationQuality) -> ifc_lite_geometry::Result<Mesh> { panic!("deliberate extension unwind") }
}
#[test]
fn canonical_extension_unwind_restores_resource_tls_and_decoder_router_owners() {
    let model = ProductionModel::new();
    let context = model.snapshot(OwnedMeshProductionData::default());
    let mut decoder = EntityDecoder::new(SOURCE);
    let mut router = admitted_router(&mut decoder);
    router.register(Box::new(PanicProcessor));
    let entity = decoder.decode_by_id(10).unwrap();
    let account = account(ResourceLimits::default());
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(||
        produce_element_meshes_owned_accounted(&job(&entity,&metadata(10)),&context,
            &options(),&mut decoder,&router,&account)));
    assert!(outcome.is_err());
    assert!(resource::current_account().is_none());
    assert!(decoder.try_execution_lease().is_ok());
    assert!(router.try_execution_lease().is_ok());
    assert_eq!(account.usage().live_bytes,0,"no output admission survived the failed callback");
}

struct Recoverable { calls: Rc<Cell<usize>> }
impl GeometryProcessor for Recoverable {
    fn supported_types(&self) -> Vec<IfcType> { vec![IfcType::IfcExtrudedAreaSolid] }
    fn process(&self,_:&DecodedEntity,_:&mut EntityDecoder,_:&IfcSchema,
        _:TessellationQuality) -> ifc_lite_geometry::Result<Mesh> {
        self.calls.set(self.calls.get()+1);
        Err(ifc_lite_geometry::Error::geometry("execution cancelled"))
    }
}
#[test]
fn ordinary_source_error_with_terminal_looking_text_retains_original_fallback_recovery() {
    let model = ProductionModel::new();
    let context = model.snapshot(OwnedMeshProductionData::default());
    let mut decoder = EntityDecoder::new(SOURCE);
    let mut router = admitted_router(&mut decoder);
    let calls = Rc::new(Cell::new(0));
    router.register(Box::new(Recoverable {calls:calls.clone()}));
    let entity = decoder.decode_by_id(10).unwrap();
    let account = account(ResourceLimits::default());
    let output = produce_element_meshes_owned_accounted(&job(&entity,&metadata(10)),&context,
        &options(),&mut decoder,&router,&account).unwrap();
    assert!(output.output().meshes.is_empty());
    assert!(calls.get()>1,"recoverable geometry failure still enters the historical fallback attempts");
    assert!(account.check().is_ok(),"error text cannot manufacture a typed stop");
}

const NESTED_ALLOWANCE:u64=1000;
struct NestedReset {
    router: std::rc::Weak<GeometryRouter>, context: std::sync::Arc<OwnedMeshProductionContext>,
    child_account: ExecutionAccount, calls: Rc<Cell<usize>>,
}
impl GeometryProcessor for NestedReset {
    fn supported_types(&self) -> Vec<IfcType> { vec![IfcType::IfcExtrudedAreaSolid] }
    fn process(&self,entity:&DecodedEntity,decoder:&mut EntityDecoder,schema:&IfcSchema,
        quality:TessellationQuality) -> ifc_lite_geometry::Result<Mesh> {
        self.calls.set(self.calls.get()+1);
        if entity.id==13 {
            let used=resource::current_account().unwrap().usage().work;
            let remaining=NESTED_ALLOWANCE.checked_sub(used).expect("fixture reaches its first callback within quota");
            resource::charge(Cost {work:remaining,..Cost::default()})?;
            let child = decoder.decode_by_id(20).unwrap();
            let caught = produce_element_meshes_owned_accounted(&job(&child,&metadata(20)),&self.context,
                &options(),decoder,&self.router.upgrade().unwrap(),&self.child_account);
            assert!(matches!(caught,Err(AccountedProductionError::Stopped(_))));
        }
        ExtrudedAreaSolidProcessor::new(schema.clone()).process(entity,decoder,schema,quality)
    }
}
#[test]
fn actual_nested_canonical_call_cannot_reset_parent_work_allowance_with_a_fresh_account() {
    for strict in [false,true] {
        let model = ProductionModel::new();
        let context = model.snapshot(OwnedMeshProductionData::default());
        let mut decoder = EntityDecoder::new(SOURCE);
        let mut geometry_router = admitted_router(&mut decoder);
        let child_account = if strict { ExecutionAccount::new(ExecutionPolicy::Strict(ResourceLimits::default())) }
            else { account(ResourceLimits::default()) };
        let calls = Rc::new(Cell::new(0));
        let router = Rc::new_cyclic(|router| {
            geometry_router.register(Box::new(NestedReset {router:router.clone(),context:context.clone(),
                child_account:child_account.clone(),calls:calls.clone()}));
            geometry_router
        });
        let entity = decoder.decode_by_id(10).unwrap();
        let account = account(ResourceLimits {work:Some(NESTED_ALLOWANCE),..ResourceLimits::default()});
        let result = produce_element_meshes_owned_accounted(&job(&entity,&metadata(10)),&context,
            &options(),&mut decoder,&router,&account);
        let dimension=if strict {resource::Dimension::Coverage} else {resource::Dimension::Work};
        assert!(matches!(result,Err(AccountedProductionError::Stopped(ProgramStop::ResourceRefused(failure)))
            if failure.dimension==dimension));
        assert_eq!(calls.get(),1,"nested work is refused before its actual geometry callback");
        assert_eq!(account.usage().work,NESTED_ALLOWANCE);
        assert_eq!(child_account.usage().work,0,"fresh child account cannot reset inherited allowance");
    }
}

#[test]
fn actual_output_handoff_retains_model_resident_permit_until_consumer_drop() {
    use ifc_lite_geometry::resource::{ModelResourcePool,RequestAdmission};
    let pool = ModelResourcePool::new(1_000_000);
    let limits = ResourceLimits {live_bytes:Some(1_000_000),..ResourceLimits::default()};
    let account = match pool.admit(limits).unwrap() {
        RequestAdmission::Ready(account) => account,
        RequestAdmission::WaitingForCapacity => panic!("fresh model pool must admit its first request"),
    };
    let model = ProductionModel::new();
    let context = model.snapshot(OwnedMeshProductionData::default());
    let mut decoder = EntityDecoder::new(SOURCE);
    let router = admitted_router(&mut decoder);
    let entity = decoder.decode_by_id(10).unwrap();
    let output = produce_element_meshes_owned_accounted(&job(&entity,&metadata(10)),&context,
        &options(),&mut decoder,&router,&account).unwrap();
    assert_same(output.output(),&canonical(10,false));
    drop(router); // Isolate the output lease after completed local caches drop.
    drop(account);
    assert!(matches!(pool.admit(limits).unwrap(),RequestAdmission::WaitingForCapacity),
        "a consumer-retained output still owns the request's resident allowance");
    drop(output);
    assert_eq!(pool.resident_bytes(),0);
    assert!(matches!(pool.admit(limits).unwrap(),RequestAdmission::Ready(_)),
        "dropping output admits the next deterministic quota without blocking");
}

#[test]
fn compatibility_account_adapter_preserves_canonical_output_without_installing_account_state() {
    let model = ProductionModel::new();
    let context = model.snapshot(OwnedMeshProductionData::default());
    let mut decoder = EntityDecoder::new(SOURCE);
    let router = router(&mut decoder);
    let entity = decoder.decode_by_id(10).unwrap();
    let account = ExecutionAccount::new(ExecutionPolicy::Compatibility);
    let output = produce_element_meshes_owned_accounted(&job(&entity,&metadata(10)),&context,
        &options(),&mut decoder,&router,&account).unwrap();
    assert_same(output.output(),&canonical(10,false));
    assert_eq!(account.usage(),resource::Usage::default());
    assert!(!resource::is_active());
}

#[test]
fn strict_adapter_rejects_opaque_coverage_before_invoking_actual_extension() {
    let model = ProductionModel::new();
    let context = model.snapshot(OwnedMeshProductionData::default());
    let mut decoder = EntityDecoder::new(SOURCE);
    let mut router = admitted_router(&mut decoder);
    let calls = Rc::new(Cell::new(0));
    router.register(Box::new(CatchStop {calls:calls.clone(),cancel:false}));
    let entity = decoder.decode_by_id(10).unwrap();
    let account = ExecutionAccount::new(ExecutionPolicy::Strict(ResourceLimits::default()));
    let result = produce_element_meshes_owned_accounted(&job(&entity,&metadata(10)),&context,
        &options(),&mut decoder,&router,&account);
    assert!(matches!(result,Err(AccountedProductionError::Stopped(ProgramStop::ResourceRefused(
        resource::ResourceFailure {dimension:resource::Dimension::Coverage,..})))));
    assert_eq!(calls.get(),0,"strict exclusion is decided before producer invocation");
    assert!(decoder.try_execution_lease().is_ok());
    assert!(router.try_execution_lease().is_ok());
}

struct FinalCancel { called: Rc<Cell<bool>>, model:ProductionModel, cancel:bool, seen:Rc<Cell<resource::Usage>> }
impl GeometryProcessor for FinalCancel {
    fn supported_types(&self) -> Vec<IfcType> {vec![IfcType::IfcExtrudedAreaSolid]}
    fn process(&self,entity:&DecodedEntity,decoder:&mut EntityDecoder,schema:&IfcSchema,
        quality:TessellationQuality) -> ifc_lite_geometry::Result<Mesh> {
        ExtrudedAreaSolidProcessor::new(schema.clone()).process(entity,decoder,schema,quality)
    }
    fn take_bool_failures(&self) -> Vec<ifc_lite_geometry::BoolFailure> {
        self.called.set(true);
        let account=resource::current_account().unwrap();
        self.seen.set(account.usage());
        if self.cancel { self.model.invalidate_source(); account.cancel(); }
        Vec::new()
    }
}
#[test]
fn final_diagnostic_callback_cancellation_retracts_current_product_success_and_releases_output() {
    let mut completed_cache_usage=None;
    for cancel in [false,true] {
        let model=ProductionModel::new();
        let context=model.snapshot(OwnedMeshProductionData::default());
        let mut decoder=EntityDecoder::new(SOURCE);
        let mut router=admitted_router(&mut decoder);
        let called=Rc::new(Cell::new(false));
        let seen=Rc::new(Cell::new(resource::Usage::default()));
        router.register(Box::new(FinalCancel {called:called.clone(),model:model.clone(),cancel,seen:seen.clone()}));
        let entity=decoder.decode_by_id(10).unwrap();
        let account=account(ResourceLimits::default());
        let result=produce_element_meshes_owned_accounted(&job(&entity,&metadata(10)),&context,
            &options(),&mut decoder,&router,&account);
        assert!(called.get());
        assert!(seen.get().output_bytes>0,"actual presentation preceded the final diagnostic callback");
        if cancel {
            assert!(matches!(result,Err(AccountedProductionError::Stopped(ProgramStop::Cancelled))));
            assert_eq!(account.usage(),completed_cache_usage.unwrap(),
                "terminal output releases exactly the same lease as dropping successful output, preserving completed caches");
        } else {
            let output=result.unwrap();
            assert_same(output.output(),&canonical(10,false));
            drop(output);
            completed_cache_usage=Some(account.usage());
        }
        assert!(account.usage().live_bytes<seen.get().live_bytes,"current output residency is released");
        assert_eq!(account.usage().output_bytes,seen.get().output_bytes,"cumulative output is never refunded");
        assert!(decoder.try_execution_lease().is_ok());
        assert!(router.try_execution_lease().is_ok());
    }
}

struct DirectStop {calls:Rc<Cell<usize>>}
impl GeometryProcessor for DirectStop {
    fn supported_types(&self) -> Vec<IfcType> {vec![IfcType::IfcExtrudedAreaSolid]}
    fn process(&self,_:&DecodedEntity,_:&mut EntityDecoder,_:&IfcSchema,
        _:TessellationQuality) -> ifc_lite_geometry::Result<Mesh> {
        self.calls.set(self.calls.get()+1);
        Err(ifc_lite_geometry::Error::ProgramStopped(ProgramStop::Cancelled))
    }
}
#[test]
fn typed_extension_stop_is_sticky_without_requiring_extension_to_set_account_state() {
    let model = ProductionModel::new();
    let context = model.snapshot(OwnedMeshProductionData::default());
    let mut decoder = EntityDecoder::new(SOURCE);
    let mut router = admitted_router(&mut decoder);
    let calls = Rc::new(Cell::new(0));
    router.register(Box::new(DirectStop {calls:calls.clone()}));
    let entity = decoder.decode_by_id(10).unwrap();
    let account = account(ResourceLimits::default());
    let result = produce_element_meshes_owned_accounted(&job(&entity,&metadata(10)),&context,
        &options(),&mut decoder,&router,&account);
    assert!(matches!(result,Err(AccountedProductionError::Stopped(ProgramStop::Cancelled))));
    assert_eq!(calls.get(),1,"typed terminal errors bypass the recoverable retry sequence");
    assert_eq!(account.check(),Err(ProgramStop::Cancelled));
}

#[test]
fn earlier_real_boolean_source_evidence_survives_a_later_terminal_extension_once() {
    let source = SOURCE.replace("'SweptSolid',(#13)","'SweptSolid',(#30,#13)")
        .replace("ENDSEC;END-ISO-10303-21;",
            "#30=IFCBOOLEANRESULT(.XOR.,#31,$);#31=IFCBLOCK($,1.,1.,1.);ENDSEC;END-ISO-10303-21;");
    let model = ProductionModel::new();
    let context = model.snapshot(OwnedMeshProductionData::default());
    let mut decoder = EntityDecoder::new(&source);
    let mut router = GeometryRouter::with_units(&source,&mut decoder);
    router.disable_content_dedup();
    decoder.seed_unit_scales(router.unit_scale(),1.);
    router.register(Box::new(CatchStop {calls:Rc::new(Cell::new(0)),cancel:true}));
    let entity = decoder.decode_by_id(10).unwrap();
    let account = account(ResourceLimits::default());
    let result = produce_element_meshes_owned_accounted(&job(&entity,&metadata(10)),&context,
        &options(),&mut decoder,&router,&account);
    assert!(matches!(result,Err(AccountedProductionError::Stopped(ProgramStop::Cancelled))));
    let evidence = router.take_csg_failures();
    let failures: Vec<_> = evidence.values().flatten().collect();
    assert!(failures.iter().any(|failure|matches!(&failure.reason,
        ifc_lite_geometry::BoolFailureReason::UnknownBooleanOperator(keyword) if keyword=="XOR")),
        "a later resource stop cannot erase the reached recoverable source refusal");
    assert!(router.take_csg_failures().is_empty(),"reached evidence is delivered once");
}

#[test]
fn bounded_adapter_preserves_default_router_configuration_and_refuses_unowned_dedup_coverage() {
    let model = ProductionModel::new();
    let context = model.snapshot(OwnedMeshProductionData::default());
    let mut decoder = EntityDecoder::new(SOURCE);
    let mut router = router(&mut decoder);
    let calls = Rc::new(Cell::new(0));
    router.register(Box::new(CatchStop {calls:calls.clone(),cancel:false}));
    let entity = decoder.decode_by_id(10).unwrap();
    let account = account(ResourceLimits::default());
    let result = produce_element_meshes_owned_accounted(&job(&entity,&metadata(10)),&context,
        &options(),&mut decoder,&router,&account);
    assert!(matches!(result,Err(AccountedProductionError::Stopped(ProgramStop::ResourceRefused(
        resource::ResourceFailure {dimension:resource::Dimension::Coverage,..})))));
    assert_eq!(calls.get(),0,"unowned cache storage is refused before numeric callbacks");
    let compatible = produce_element_meshes_owned(&job(&entity,&metadata(10)),&context,
        &options(),&mut decoder,&router).unwrap();
    assert_same(&compatible,&canonical(10,false));
    assert!(calls.get()>0,"the existing default router remains available to compatibility callers");
}
