// SPDX-License-Identifier: MPL-2.0
//! #7955 M2/M6: the public native entry consumes parsed source and type jobs.
use super::*;
use crate::element::session_tests::SOURCE;
use crate::retained_native_contract as wire;
const IMPLEMENTATION: &str = "9a2918e52207bafa5dbea4864c83efe776a71cce";
fn valid_ids(bytes: &str) -> String {
    bytes.replace("IFCWALL('w'", "IFCWALL('0123456789012345678901'")
        .replace("IFCBOILERTYPE('t'", "IFCBOILERTYPE('1123456789012345678901'")
}
use std::{future::Future, task::{Context, Poll, Wake, Waker}};

fn run<T>(future: impl Future<Output = T>) -> T {
    struct Notify(std::thread::Thread);
    impl Wake for Notify { fn wake(self: Arc<Self>) { self.0.unpark(); } }
    let waker = Waker::from(Arc::new(Notify(std::thread::current())));
    let mut context = Context::from_waker(&waker);
    let mut future = Box::pin(future);
    loop {
        match future.as_mut().poll(&mut context) {
            Poll::Ready(value) => return value,
            Poll::Pending => std::thread::park(),
        }
    }
}
fn source(extra: &str) -> Arc<SourceBundle> {
    SourceBundle::new(valid_ids(SOURCE).replace("ENDSEC;END-ISO", &format!("{extra}ENDSEC;END-ISO")).into_bytes())
}
fn diagnose(source: Arc<SourceBundle>, id: u32, path: &Path, mode: TypeGeometryMode)
    -> Result<NativeTransactionDiagnostic, NativeDiagnosticError> {
    run(diagnose_retained_native(source, id, path, &options(mode), IMPLEMENTATION))
}
fn options(mode: TypeGeometryMode) -> String {
    let mode = match mode { TypeGeometryMode::SuppressInstanced => "suppress_instanced", TypeGeometryMode::EmitTagged => "emit_tagged" };
    format!(r#"{{"schemaVersion":1,"chordToleranceMetres":0.001,"angleToleranceRadians":0.2617993877991494,
        "maxWork":"1000000","maxBytes":"268435456","deadlineMs":"60000","typeGeometryMode":"{mode}",
        "normalPolicy":"source_analytic_v1","instancePolicy":"uncut_mapped_v1","interfacePolicy":"certified_internal_v1",
        "openings":"all","layers":"preserve","skipSmallCuts":false,"mergeLayers":false}}"#)
}
#[test]
fn issue_7955_native_source_m2_parsed_unsupported_block_and_malformed_items_are_distinct_before_worker_spawn() {
    let block = SOURCE.replace("#13=IFCEXTRUDEDAREASOLID(#14,#5,#15,3.)", "#13=IFCBLOCK(#5,2.,4.,3.)");
    let malformed = SOURCE.replace("'SweptSolid',(#13)", "'SweptSolid',(42)");
    for (bytes, expected) in [(block, wire::Code::OperationUnsupported), (malformed, wire::Code::SourceInvalid)] {
        let bytes = valid_ids(&bytes);
        let expected_hash = format!("{:x}", <sha2::Sha256 as sha2::Digest>::digest(bytes.as_bytes()));
        let error = diagnose(SourceBundle::new(bytes.into_bytes()), 10,
            Path::new("/nonexistent/never-start-a-worker-for-source-refusal"), TypeGeometryMode::EmitTagged)
            .err().expect("actual parsed source refuses");
        assert_eq!(error.cause.code(), expected, "M2_KNOWN_ORIGIN_REPORT");
        let report: serde_json::Value = serde_json::from_slice(error.report_bytes().expect("bound refusal")).unwrap();
        assert_eq!(report["outcome"]["refusal"]["code"], serde_json::to_value(&expected).unwrap());
        assert_eq!(report["identity"]["source"]["sha256"], expected_hash);
        assert_eq!(report["product"]["GlobalId"]["value"], "0123456789012345678901");
        assert_eq!(report["product"]["productId"], "10");
        assert_eq!(report["identity"]["source"]["revision"], "1");
        assert_eq!(report["identity"]["options"]["typeGeometryMode"], "emit_tagged");
        assert_eq!(report["implementationCommit"], IMPLEMENTATION);
        assert_eq!(report["outcome"]["refusal"]["exactRetry"], "explicit_new_exact_request");
        assert_eq!(report["outcome"]["refusal"]["stage"], if expected == wire::Code::OperationUnsupported { "representation" } else { "source" });
        assert_eq!(report["outcome"]["refusal"]["requirement"], if expected == wire::Code::OperationUnsupported { "representation" } else { "source_authentication" });
    }
}
#[test]
fn issue_7955_native_source_m6_public_entry_suppresses_instantiated_type_without_worker_or_final_authority() {
    let diagnostic = diagnose(source("#200=IFCRELDEFINESBYTYPE('r',$,$,$,(#10,#20),#60);"), 60,
        Path::new("/nonexistent/no-numerical-work"), TypeGeometryMode::SuppressInstanced).unwrap();
    assert_eq!(diagnostic.witness.discharged_count(), 0);
    assert_eq!(diagnostic.witness.plan().values().len(), 0);
    assert!(diagnostic.require_final_product().is_err());
    assert!(diagnostic.witness.plan().requirements().any(|r| r == RetainedRequirement::ProductPlacement));
}
#[test]
fn issue_7955_m6_canonical_type_jobs_reach_real_native_origin_and_class_bindings() {
    let Some(path) = std::env::var_os("IFCLITE_SMLIB_WORKER") else {
        eprintln!("SKIP M6 diagnostic SDK witness: set IFCLITE_SMLIB_WORKER"); return;
    };
    for (extra, mode, class, count) in [
        ("", TypeGeometryMode::SuppressInstanced, 1, 2),
        ("#200=IFCRELDEFINESBYTYPE('r',$,$,$,(#10,#20),#60);", TypeGeometryMode::EmitTagged, 2, 2),
        ("#200=IFCMAPPEDITEM(#61,#201);#201=IFCCARTESIANTRANSFORMATIONOPERATOR3D($,$,#4,1.,$);",
            TypeGeometryMode::EmitTagged, 1, 1),
    ] {
        let diagnostic = diagnose(source(extra), 60, Path::new(&path), mode).unwrap();
        diagnostic.bytes().unwrap();
        assert_eq!(diagnostic.witness.discharged_count(), count);
        let values: Vec<_> = diagnostic.witness.plan().values().collect();
        assert_eq!(values.len(), count);
        for value in &values { assert_eq!(value.bindings().last().unwrap().2, Some((60, class))); }
        let frame = values.last().unwrap().world_from_source().unwrap();
        assert_eq!([frame[12], frame[13], frame[14]], [-4., 3., 2.], "actual MappingOrigin");
        assert!(diagnostic.require_final_product().is_err());
    }
}
#[test]
fn issue_7955_native_source_m6_type_selection_uses_source_bundle_last_occurrence_and_preserves_map_order() {
    let source = source("#200=IFCMAPPEDITEM(#61,#201);#200=IFCCARTESIANPOINT((0.,0.,0.));");
    let context = ProductionModel::from_source(source.clone()).snapshot(Default::default());
    let mut decoder = source.decoder();
    let prepared = diagnostic_source::prepare(&source, &context, &mut decoder, 60, TypeGeometryMode::EmitTagged).unwrap();
    let ElementJobKind::TypeProduct { rep_maps } = prepared.kind else { panic!("actual type job") };
    assert_eq!(rep_maps, vec![(61, 1), (71, 1)]);
}

#[test]
fn issue_7955_native_source_m2_native_options_keep_typed_deadline_and_original_cancel_precedence() {
    resource::inspection_test_clock::scope(|clock| {
        clock.expire_at("source_step", 1, 60_000);
        let error = diagnose(source(""), 10, Path::new("/nonexistent/no-worker-after-deadline"),
            TypeGeometryMode::EmitTagged).err().expect("original deadline refuses");
        assert_eq!(error.cause.code(), wire::Code::DeadlineExceeded);
        let original = resource::ExecutionAccount::new(resource::ExecutionPolicy::Bounded(Default::default()));
        original.cancel();
        let error = original.scope(|| diagnose(source(""), 10, Path::new("/nonexistent/no-worker-after-stop"),
            TypeGeometryMode::EmitTagged)).err().expect("original cancellation wins");
        assert!(matches!(error.cause, RetainedExecutionError::Stopped(ProgramStop::Cancelled)));
        assert_eq!(error.cause.code(), wire::Code::Cancelled);
    });
}

#[test]
fn issue_7955_native_source_m2_generated_native_report_rejects_rebinding_context_and_finality_tampering() {
    let diagnostic = diagnose(source("#200=IFCRELDEFINESBYTYPE('r',$,$,$,(#10,#20),#60);"), 60,
        Path::new("/nonexistent/no-numerical-work"), TypeGeometryMode::SuppressInstanced).unwrap();
    let original: serde_json::Value = serde_json::from_slice(diagnostic.bytes().unwrap()).unwrap();
    let binding = wire::Binding {
        identity: serde_json::from_value(original["identity"].clone()).unwrap(),
        enumeration_complete: false, non_geometric: vec![],
        requested: vec![serde_json::from_value(original["product"].clone()).unwrap()],
    };
    let json = serde_json::to_string(&original).unwrap();
    wire::decode_native_report(&json, &binding).unwrap();
    for (pointer, replacement) in [
        ("/identity/source/sha256", serde_json::json!("f".repeat(64))),
        ("/identity/source/revision", serde_json::json!("2")),
        ("/identity/options/typeGeometryMode", serde_json::json!("emit_tagged")),
        ("/identity/resultId", serde_json::json!("e".repeat(64))),
        ("/product/productId", serde_json::json!("20")),
        ("/finalProductAvailable", serde_json::json!(true)),
        ("/unchecked", serde_json::json!(["numerical_evaluation"])),
    ] {
        let mut changed = original.clone();
        *changed.pointer_mut(pointer).unwrap() = replacement;
        assert!(wire::decode_native_report(&serde_json::to_string(&changed).unwrap(), &binding).is_err(), "{pointer}");
    }
    let duplicate = json.replacen("\"schemaVersion\":1.0", "\"schemaVersion\":1.0,\"schemaVersion\":1.0", 1);
    assert_ne!(duplicate, json);
    assert!(wire::decode_native_report(&duplicate, &binding).is_err());
}
