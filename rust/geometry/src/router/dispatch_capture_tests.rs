// SPDX-License-Identifier: MPL-2.0
//! Sparse traces identify actual entries while metadata and other owners stay quiet.
use super::*;
use crate::{GeometryProcessor, GeometryRouter, Mesh, Result, TessellationQuality};
use ifc_lite_core::{DecodedEntity, EntityDecoder, IfcSchema, IfcType};
use std::panic::{catch_unwind, AssertUnwindSafe};

const SOURCE: &str = "#1=IFCBLOCK($,1.,2.,3.);#2=IFCSPHERE($,1.);
#3=IFCBOOLEANRESULT(.XOR.,#1,$);#4=IFCBOOLEANCLIPPINGRESULT(.NOR.,#1,$);";
fn process(router: &GeometryRouter, id: u32) -> Mesh {
    let mut decoder = EntityDecoder::new(SOURCE);
    let entity = decoder.decode_by_id(id).unwrap();
    let mesh = router.process_representation_item(&entity, &mut decoder).unwrap();
    assert!(!mesh.is_empty(), "actual constructors must run");
    mesh
}

#[test]
fn metadata_is_untraced_and_repeated_actual_builtin_entries_have_one_identity() {
    let router = GeometryRouter::new();
    let (_, quiet) = ProcessorDispatchCapture::capture(|| {
        assert_eq!(router.processor_origin(&IfcType::IfcBlock), Some(super::super::ProcessorOrigin::Builtin));
        // Even a processor lookup is not numerical entry.
        assert!(router.processor_for(&IfcType::IfcBlock).is_some());
    });
    assert!(quiet.is_empty());
    let (_, trace) = ProcessorDispatchCapture::capture(|| { process(&router, 1); process(&router, 1); });
    assert_eq!(trace.len(), 1, "identity capture is bounded by live emitters, not occurrences");
    assert_eq!(trace[0].origin(), ProcessorEmitterOrigin::Builtin);
    assert_eq!(trace[0].family(), Some(ConstructionFamily::Block));
    let (_, again) = ProcessorDispatchCapture::capture(|| { process(&router, 1); });
    assert_eq!(again, trace);
}

struct AliasedBoolean;
impl GeometryProcessor for AliasedBoolean {
    fn supported_types(&self) -> Vec<IfcType> {
        vec![IfcType::IfcBooleanResult, IfcType::IfcBooleanClippingResult]
    }
    fn process(&self, entity: &DecodedEntity, decoder: &mut EntityDecoder,
        schema: &IfcSchema, quality: TessellationQuality) -> Result<Mesh> {
        crate::processors::BooleanClippingProcessor::new().process(entity, decoder, schema, quality)
    }
}

#[test]
fn actual_custom_aliases_share_identity_and_registration_replacement_changes_it() {
    let mut router = GeometryRouter::new();
    router.register(Box::new(AliasedBoolean));
    let (_, trace) = ProcessorDispatchCapture::capture(|| { process(&router, 3); process(&router, 4); });
    assert_eq!(trace.len(), 1);
    assert_eq!(trace[0].origin(), ProcessorEmitterOrigin::Custom);
    assert_eq!(trace[0].family(), None, "advertised aliases cannot establish builtin semantics");
    router.register(Box::new(AliasedBoolean));
    let (_, replacement) = ProcessorDispatchCapture::capture(|| { process(&router, 4); });
    assert_eq!(replacement.len(), 1);
    assert_ne!(replacement, trace);
}

#[test]
fn actual_configured_builtins_have_registration_identity_instead_of_default_identity() {
    let mut router = GeometryRouter::new();
    let (_, before) = ProcessorDispatchCapture::capture(|| { process(&router, 3); });
    router.set_skip_small_cuts(true);
    let (_, after) = ProcessorDispatchCapture::capture(|| { process(&router, 3); process(&router, 4); });
    assert_eq!(after.len(), 1);
    assert_ne!(before, after);
    assert_eq!(after[0].origin(), ProcessorEmitterOrigin::ConfiguredBuiltin);
    assert_eq!(after[0].family(), Some(ConstructionFamily::Boolean));
}

#[test]
fn nested_capture_and_error_keep_actual_entry_evidence_with_ambient_trace_restored() {
    let router = GeometryRouter::new();
    let mut inner = Vec::new();
    let (error, outer) = ProcessorDispatchCapture::capture(|| {
        process(&router, 1);
        let (_, captured) = ProcessorDispatchCapture::capture(|| { process(&router, 2); });
        inner = captured;
        process(&router, 1);
        Err::<(), _>("work refused")
    });
    assert_eq!(error, Err("work refused"));
    assert_eq!(outer.len(), 1);
    assert_eq!(inner.len(), 1);
    assert_eq!(outer[0].family(), Some(ConstructionFamily::Block));
    assert_eq!(inner[0].family(), Some(ConstructionFamily::Sphere));
    assert!(!enabled());
}

#[test]
fn externally_owned_capture_retains_failed_work_on_panic_and_restores_its_caller() {
    let router = GeometryRouter::new();
    let mut failed = ProcessorDispatchCapture::new();
    let (_, ambient) = ProcessorDispatchCapture::capture(|| {
        process(&router, 1);
        let panic = catch_unwind(AssertUnwindSafe(|| failed.with_scope(|| {
            process(&router, 2);
            panic!("controlled numerical work panic");
        })));
        assert!(panic.is_err());
        process(&router, 1);
    });
    let failed = failed.take();
    assert_eq!(ambient.len(), 1);
    assert_eq!(failed.len(), 1);
    assert_eq!(ambient[0].family(), Some(ConstructionFamily::Block));
    assert_eq!(failed[0].family(), Some(ConstructionFamily::Sphere));
    assert!(!enabled());
}
