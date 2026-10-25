// SPDX-License-Identifier: MPL-2.0
//! #7955 M2/M6: the public native entry consumes parsed source and type jobs.
use super::*;
use crate::element::session_tests::SOURCE;
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
    SourceBundle::new(SOURCE.replace("ENDSEC;END-ISO", &format!("{extra}ENDSEC;END-ISO")).into_bytes())
}
fn diagnose(source: Arc<SourceBundle>, id: u32, path: &Path, mode: TypeGeometryMode)
    -> Result<NativeTransactionDiagnostic, NativeDiagnosticError> {
    run(diagnose_retained_native(source, id, path, 0.001, 15., 256 * 1024 * 1024, 1_000_000, mode))
}
#[test]
fn issue_7955_m2_parsed_unsupported_block_and_malformed_items_are_distinct_before_worker_spawn() {
    let block = SOURCE.replace("#13=IFCEXTRUDEDAREASOLID(#14,#5,#15,3.)", "#13=IFCBLOCK(#5,2.,4.,3.)");
    let malformed = SOURCE.replace("'SweptSolid',(#13)", "'SweptSolid',(42)");
    for (bytes, expected) in [(block, "\"OPERATION_UNSUPPORTED\""), (malformed, "\"SOURCE_INVALID\"")] {
        let error = diagnose(SourceBundle::new(bytes.into_bytes()), 10,
            Path::new("/nonexistent/never-start-a-worker-for-source-refusal"), TypeGeometryMode::EmitTagged)
            .err().expect("actual parsed source refuses");
        assert_eq!(error.diagnostic_code_json(), expected, "M2_KNOWN_ORIGIN_REPORT");
    }
}
#[test]
fn issue_7955_m6_public_entry_suppresses_instantiated_type_without_worker_or_final_authority() {
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
fn issue_7955_m6_type_selection_uses_source_bundle_last_occurrence_and_preserves_map_order() {
    let source = source("#200=IFCMAPPEDITEM(#61,#201);#200=IFCCARTESIANPOINT((0.,0.,0.));");
    let context = ProductionModel::from_source(source.clone()).snapshot(Default::default());
    let mut decoder = source.decoder();
    let prepared = diagnostic_source::prepare(&source, &context, &mut decoder, 60, TypeGeometryMode::EmitTagged).unwrap();
    let ElementJobKind::TypeProduct { rep_maps } = prepared.kind else { panic!("actual type job") };
    assert_eq!(rep_maps, vec![(61, 1), (71, 1)]);
}
