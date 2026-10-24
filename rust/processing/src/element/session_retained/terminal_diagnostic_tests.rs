// SPDX-License-Identifier: MPL-2.0
//! #7955 R5: actual final-hook failure evidence survives rejection and unwind.
use super::*;
use ifc_lite_geometry::{BooleanClippingProcessor, GeometryProcessor, TessellationQuality};
use std::cell::Cell;
struct ReportingHook {
    recorder: BooleanClippingProcessor,
    source: String,
    schema: ifc_lite_core::IfcSchema,
    model: ProductionModel,
    fired: Cell<bool>,
    unwind: bool,
}
impl GeometryProcessor for ReportingHook {
    fn supported_types(&self) -> Vec<IfcType> { vec![IfcType::IfcCircle] }
    fn process(&self, _: &DecodedEntity, _: &mut EntityDecoder, _: &ifc_lite_core::IfcSchema,
        _: TessellationQuality) -> ifc_lite_geometry::Result<Mesh> {
        panic!("fixture contains no circle construction")
    }
    fn boolean_recorder(&self) -> Option<&BooleanClippingProcessor> { Some(&self.recorder) }
    fn take_bool_failures(&self) -> Vec<BoolFailure> {
        if self.fired.replace(true) { return self.recorder.take_failures(); }
        // Produce real unsupported-XOR evidence through the exact processor.
        // Do not fabricate a BoolFailure or manipulate diagnostic router state.
        let mut decoder = EntityDecoder::new(&self.source);
        let entity = decoder.decode_by_id(987).unwrap();
        let mesh = self.recorder.process(&entity,&mut decoder,&self.schema,TessellationQuality::Medium).unwrap();
        assert!(!mesh.is_empty(),"J2_TERMINAL_DIAGNOSTIC_SOURCE");
        if self.unwind { panic!("J2 diagnostic hook unwind after recording"); }
        self.model.invalidate_source();
        self.recorder.take_failures()
    }
}
#[test]
fn j2_terminal_recorded_failure_survives_rejection_and_unwind_once() {
    let Some(mut worker) = super::tests::worker() else { return };
    for unwind in [false,true] {
        let text = super::opening_witness::removal_sources().remove(0);
        let source = ifc_lite_core::SourceBundle::new(text.clone().into_bytes());
        let mut decoder = source.decoder();
        let mut router = GeometryRouter::with_units(source.bytes(),&mut decoder);
        let model = ProductionModel::from_source(source.clone());
        let hook = ReportingHook { recorder:BooleanClippingProcessor::new(),
            source:text.replace("ENDSEC;\nEND-ISO-10303-21;",
                "#987=IFCBOOLEANRESULT(.XOR.,#26,$);\nENDSEC;END-ISO-10303-21;"),
            schema:router.schema().clone(),model:model.clone(),fired:Cell::new(false),unwind };
        router.register(Box::new(hook));
        let mut spans = crate::prepass::PrepassSpans::default();
        let mut scanner = ifc_lite_core::EntityScanner::new(source.bytes());
        while let Some((id,name,start,end)) = scanner.next_entity() {
            if ifc_lite_core::keyword_eq(name,"IFCRELVOIDSELEMENT") { spans.void_rels.push((id,start,end)); }
        }
        let prepass = crate::prepass::resolve_prepass(&spans,&mut decoder,crate::prepass::ResolveOptions::default());
        let data = OwnedMeshProductionData {void_index:Arc::new(prepass.void_index),..Default::default()};
        let context = model.snapshot(data.clone());
        let entity = decoder.decode_by_id(30).unwrap();
        let job = ElementMeshJob {id:30,entity:&entity,ifc_type:entity.ifc_type.clone(),
            kind:ElementJobKind::Product,element_color:None,metadata:None};
        let mut execution = RetainedProductExecution::begin(&job,&context,&MeshProductionOptions::default(),&mut decoder,&router).unwrap();
        super::terminal_tests::complete(&mut execution,&mut decoder,&router,&mut worker);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(||
            execution.publish_removed(&mut decoder,&router,&worker)));
        if unwind { assert!(result.is_err()); } else {
            assert!(result.unwrap().is_err());
            assert!(context.validate_source().is_err());
        }
        assert!(!router.host_consumed_by_void(30),"J2_TERMINAL_DIAGNOSTIC_EFFECT");
        drop(execution);
        // Real subsequent terminal publication on the same warm router must
        // not steal quarantined evidence from the failed predecessor.
        let next_model = ProductionModel::from_source(source.clone());
        let next_context = next_model.snapshot(data);
        let mut next = RetainedProductExecution::begin(&job,&next_context,&MeshProductionOptions::default(),&mut decoder,&router).unwrap();
        super::terminal_tests::complete(&mut next,&mut decoder,&router,&mut worker);
        let output = next.publish_removed(&mut decoder,&router,&worker).expect("J2_TERMINAL_DIAGNOSTIC_SUCCESSOR").into_output();
        assert!(output.csg_failures.is_empty(),"J2_TERMINAL_DIAGNOSTIC_NOT_ADOPTED");
        drop(next);
        let reports = router.take_csg_failures();
        assert_eq!(reports.len(),1,"J2_TERMINAL_DIAGNOSTIC_RETAINED");
        let failures = reports.get(&ifc_lite_geometry::UNATTRIBUTED_PRODUCT_ID).unwrap();
        assert_eq!(failures.len(),1,"J2_TERMINAL_DIAGNOSTIC_ONCE");
        assert_eq!(failures[0].product_id,None);
        assert!(matches!(&failures[0].reason,ifc_lite_geometry::BoolFailureReason::UnknownBooleanOperator(op) if op=="XOR"));
        assert!(router.take_csg_failures().is_empty(),"J2_TERMINAL_DIAGNOSTIC_ONCE");
    }
}
