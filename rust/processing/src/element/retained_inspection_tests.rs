// SPDX-License-Identifier: MPL-2.0
//! #7955: parsed source, reached numerical work, and independent owner lifetimes.
use super::*;
use ifc_lite_core::AttributeValue;
use resource::{Dimension, RefusalReason, ResourceFailure};

pub(super) const SOURCE: &str = "ISO-10303-21;HEADER;FILE_SCHEMA(('IFC4'));ENDSEC;DATA;
#1=IFCCARTESIANPOINT((0.,0.,0.));#2=IFCAXIS2PLACEMENT3D(#1,$,$);
#3=IFCDIRECTION((0.,0.,1.));#4=IFCLOCALPLACEMENT($,#2);
#5=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#2,$);
#10=IFCWALL('0000000000000000000001',$,'Wall',$,$,#4,#11,$,$);
#11=IFCPRODUCTDEFINITIONSHAPE($,$,(#12));
#12=IFCSHAPEREPRESENTATION(#5,'Body','SweptSolid',(#13));
#13=IFCEXTRUDEDAREASOLID(#14,#2,#3,3.);#14=IFCRECTANGLEPROFILEDEF(.AREA.,$,$,2.,4.);
#23=IFCEXTRUDEDAREASOLID(#14,#2,#3,$);
ENDSEC;END-ISO-10303-21;";
pub(super) const OPTIONS: &str = r#"{"schemaVersion":1,"chordToleranceMetres":0.001,"angleToleranceRadians":0.1,
"maxWork":"10000","maxBytes":"16777216","deadlineMs":"10000","typeGeometryMode":"suppress_instanced",
"normalPolicy":"source_analytic_v1","instancePolicy":"uncut_mapped_v1","interfacePolicy":"certified_internal_v1",
"openings":"all","layers":"preserve","skipSmallCuts":false,"mergeLayers":false}"#;
// Descriptive test identity only; compile provenance is exercised by the census.
fn commit() -> String { "0".repeat(40) }

fn run(source: Arc<SourceBundle>, options: &str) -> Result<RetainedSourceInspection, RetainedInspectionError> {
    let mut decoder = source.decoder();
    let root = decoder.decode_by_id(10).ok();
    inspect_retained_source(source.clone(), 10, root.as_ref(), &mut decoder, options, &commit())
}
fn inspect(text: &str) -> RetainedSourceInspection {
    run(SourceBundle::new(text.as_bytes().to_vec()), OPTIONS).unwrap()
}
fn value(report: &RetainedSourceInspection) -> serde_json::Value {
    serde_json::from_slice(report.bytes().unwrap()).unwrap()
}
#[test]
fn issue_7955_cut_c_extrusion_reaches_actual_nonempty_numerical_batch_without_finality() {
    let report = inspect(SOURCE);
    let value = value(&report);
    assert_eq!(value["outcome"]["kind"], "requires_numerical_evaluation");
    assert!(value["outcome"]["requestOrdinal"].as_str().unwrap().parse::<u64>().unwrap() > 1);
    assert_eq!(value["authority"], "diagnostic_only");
    for requirement in ["representation", "numerical_evaluation", "openings", "layers", "textures", "palettes",
        "normals", "face_identity", "final_geometry", "protected_removal", "publication"] {
        assert!(value["unchecked"].as_array().unwrap().contains(&serde_json::json!(requirement)));
    }
    assert!(value.get("partition").is_none());
}
#[test]
fn issue_7955_cut_c_malformed_source_before_boundary_refuses_but_late_operand_is_unknown() {
    let malformed = SOURCE.replace("(#13));", "(#13,$));");
    let refused = value(&inspect(&malformed));
    assert_eq!(refused["outcome"]["kind"], "refused");
    assert_eq!(refused["outcome"]["refusal"]["code"], "SOURCE_INVALID");
    let late = SOURCE.replace("(#13));", "(#13,#23));");
    assert_eq!(value(&inspect(&late))["outcome"]["kind"], "requires_numerical_evaluation");
}
#[test]
fn issue_7955_cut_c_source_options_and_global_id_are_authenticated() {
    let base = value(&inspect(SOURCE));
    let changed = value(&inspect(&SOURCE.replace("3.);#14", "4.);#14")));
    assert_ne!(base["identity"]["source"]["sha256"], changed["identity"]["source"]["sha256"]);
    assert_ne!(base["identity"]["resultId"], changed["identity"]["resultId"]);
    let options = OPTIONS.replace("0.001", "0.002");
    let report = run(SourceBundle::new(SOURCE.as_bytes().to_vec()), &options).unwrap();
    assert_ne!(base["identity"]["resultId"], value(&report)["identity"]["resultId"]);
    for options in [OPTIONS.replace("\"mergeLayers\":false", "\"mergeLayers\":true"),
        OPTIONS.replace("0.001", "0"), OPTIONS.replace("\"maxWork\":\"10000\"", "\"maxWork\":\"0\"")] {
        let error = run(SourceBundle::new(SOURCE.as_bytes().to_vec()), &options).err().unwrap();
        assert_eq!(error.diagnostic_code_json(), "\"INVALID_OPTIONS\"");
    }
    let invalid = SOURCE.replace("0000000000000000000001", "w");
    let error = run(SourceBundle::new(invalid.into_bytes()), OPTIONS).err().unwrap();
    assert_eq!(error.diagnostic_code_json(), "\"SOURCE_INVALID\"");
    let absent = SOURCE.replace("'0000000000000000000001'", "$");
    assert_eq!(value(&inspect(&absent))["product"]["GlobalId"]["kind"], "absent");
}
#[test]
fn issue_7955_cut_c_foreign_decoder_forged_root_stale_source_and_busy_owner_refuse() {
    let source = SourceBundle::new(SOURCE.as_bytes().to_vec());
    let foreign = SourceBundle::new(SOURCE.as_bytes().to_vec());
    let model = ProductionModel::from_source(source.clone());
    let snapshot = model.snapshot(Default::default());
    let options = wire::decode_options(OPTIONS).unwrap();
    let router = GeometryRouter::with_scale(1.);
    let check = |decoder: &mut EntityDecoder, root| inspect_bound(&source, snapshot.clone(), 10, root,
        &options, &commit(), decoder, &router);
    let mut foreign_decoder = foreign.decoder();
    assert_eq!(check(&mut foreign_decoder, None).err().unwrap().diagnostic_code_json(), "\"SOURCE_MISMATCH\"");
    let mut decoder = source.decoder();
    let root = decoder.decode_by_id(10).unwrap();
    let mut forged = root.clone();
    Arc::make_mut(&mut forged.attributes)[2] = AttributeValue::String("forged".into());
    assert_eq!(check(&mut decoder, Some(&forged)).err().unwrap().diagnostic_code_json(), "\"SOURCE_MISMATCH\"");
    let lease = decoder.try_execution_lease().unwrap();
    assert_eq!(check(&mut decoder, None).err().unwrap().diagnostic_code_json(), "\"OWNER_BUSY\"");
    drop(lease);
    let report = check(&mut decoder, Some(&root)).unwrap();
    assert!(decoder.try_execution_lease().is_ok());
    assert!(router.try_execution_lease().is_ok());
    model.invalidate_source();
    assert_eq!(report.bytes().err().unwrap().diagnostic_code_json(), "\"SOURCE_STALE\"");
    assert_eq!(check(&mut decoder, None).err().unwrap().diagnostic_code_json(), "\"SOURCE_STALE\"");
}
#[test]
fn issue_7955_cut_c_original_stop_survives_scope_and_foreign_ambient() {
    let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
    let report = account.scope(|| inspect(SOURCE));
    let stop = ProgramStop::ResourceRefused(ResourceFailure {
        dimension: Dimension::Work, requested: 9, remaining: 2, reason: RefusalReason::Limit,
    });
    account.stop(stop);
    let unrelated = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
    unrelated.scope(|| assert_eq!(report.bytes().err().unwrap().original_stop(), Some(stop)));
    resource::detached(|| assert_eq!(report.bytes().err().unwrap().original_stop(), Some(stop)));
}
#[test]
fn issue_7955_cut_c_detached_stop_and_report_drop_keep_original_domain_isolated() {
    let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
    let source = SourceBundle::new(SOURCE.as_bytes().to_vec());
    let weak = Arc::downgrade(&source);
    let report = account.scope(|| {
        let report = run(source.clone(), OPTIONS).unwrap();
        resource::detached(|| {
            resource::stop(ProgramStop::Cancelled);
            assert!(resource::check_current().is_ok());
        });
        report
    });
    drop(source);
    assert!(weak.upgrade().is_some());
    let held = account.usage().live_bytes;
    assert!(held >= report.bytes().unwrap().len() as u64);
    drop(report);
    assert!(weak.upgrade().is_none());
    assert!(account.usage().live_bytes < held);
    assert!(account.check().is_ok());
}
#[test]
fn issue_7955_cut_c_zero_source_work_budget_preserves_original_payload() {
    let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits { work: Some(0), ..Default::default() }));
    let error = account.scope(|| run(SourceBundle::new(SOURCE.as_bytes().to_vec()), OPTIONS)).err().unwrap();
    let stop = account.check().unwrap_err();
    assert_eq!(error.original_stop(), Some(stop));
    assert!(matches!(stop, ProgramStop::ResourceRefused(ResourceFailure { dimension: Dimension::Work, remaining: 0, .. })));
}

#[test]
fn issue_7955_cut_c_post_scope_source_and_original_stop_validation_precede_report_return() {
    let source = SourceBundle::new(SOURCE.as_bytes().to_vec());
    let options = wire::decode_options(OPTIONS).unwrap();
    for invalidate in [true, false] {
        let model = ProductionModel::from_source(source.clone());
        let snapshot = model.snapshot(Default::default());
        let mut decoder = source.decoder();
        let router = GeometryRouter::with_scale(1.);
        let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
        let error = account.scope(|| inspect_bound_after(&source, snapshot, 10, None, &options, &commit(),
            &mut decoder, &router, || {
                // This hook is after ProductOwner restored its source scope.
                if invalidate { model.invalidate_source(); } else { account.cancel(); }
            })).err().unwrap();
        if invalidate { assert_eq!(error.diagnostic_code_json(), "\"SOURCE_STALE\""); }
        else { assert_eq!(error.original_stop(), Some(ProgramStop::Cancelled)); }
        assert!(decoder.try_execution_lease().is_ok());
        assert!(router.try_execution_lease().is_ok());
    }
}

#[test]
fn issue_7955_cut_c_unwind_releases_scope_leases_report_and_source() {
    let source = SourceBundle::new(SOURCE.as_bytes().to_vec());
    let model = ProductionModel::from_source(source.clone());
    let snapshot = model.snapshot(Default::default());
    let options = wire::decode_options(OPTIONS).unwrap();
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_scale(1.);
    let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
    let weak = Arc::downgrade(&snapshot);
    let panic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| account.scope(|| {
        let _ = inspect_bound_after(&source, snapshot, 10, None, &options, &commit(), &mut decoder, &router,
            || panic!("#7955 after-scope unwind"));
    })));
    assert!(panic.is_err());
    assert!(weak.upgrade().is_none());
    assert!(resource::current_account().is_none());
    assert!(decoder.try_execution_lease().is_ok());
    assert!(router.try_execution_lease().is_ok());
}

#[test]
fn issue_7955_cut_c_actual_source_stop_precedes_account_and_restored_ambient() {
    let source = SourceBundle::new(SOURCE.as_bytes().to_vec());
    let model = ProductionModel::from_source(source.clone());
    let snapshot = model.snapshot(Default::default());
    let options = wire::decode_options(OPTIONS).unwrap();
    let mut decoder = source.decoder();
    let router = GeometryRouter::with_scale(1.);
    let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
    let mut owner = session_owner::ProductOwner::admit(&decoder, &router).unwrap();
    let ((report, source_stop), _) = account.scope(|| owner.work(&mut decoder, &router, |decoder, router| {
        snapshot.validate_decoder(decoder).unwrap();
        let root = decoder.decode_by_id(10).unwrap();
        let binding = binding::from_source(&source, &root, &options, 1).unwrap();
        let lease = decoder.try_source_execution_lease().unwrap().unwrap();
        let source_stop = lease.source_stop_handle().unwrap().unwrap();
        drop(lease);
        let report = ifc_lite_geometry::program::inspect_retained_program_source(&root, decoder, router,
            &serde_json::to_string(&binding).unwrap(), 0, &commit()).unwrap();
        (report, source_stop)
    })).unwrap();
    drop(owner);
    let stop = ProgramStop::ResourceRefused(ResourceFailure {
        dimension: Dimension::CopyBytes, requested: 37, remaining: 11, reason: RefusalReason::Limit,
    });
    source_stop.stop(stop);
    account.cancel();
    let foreign = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
    foreign.scope(|| assert_eq!(report.validate_original_stop(), Err(stop)));
    assert_eq!(foreign.usage().work, 0);
    assert!(decoder.try_execution_lease().is_ok());
}

#[test]
fn issue_7955_cut_c_production_decode_preserves_binary64_options() {
    let options = OPTIONS.replace("0.001", "0.12345678901234567");
    let report = run(SourceBundle::new(SOURCE.as_bytes().to_vec()), &options).unwrap();
    assert_eq!(value(&report)["identity"]["options"]["chordToleranceMetres"].as_f64().unwrap().to_bits(),
        0x3fbf9add3746f65e);
}

#[test]
fn issue_7955_cut_c_options_bound_source_work_and_backing_even_in_generous_ambient() {
    for options in [OPTIONS.replace("\"maxWork\":\"10000\"", "\"maxWork\":\"1\""),
        OPTIONS.replace("\"maxBytes\":\"16777216\"", "\"maxBytes\":\"1\"")] {
        let account = ExecutionAccount::new(ExecutionPolicy::Bounded(ResourceLimits::default()));
        let error = account.scope(|| run(SourceBundle::new(SOURCE.as_bytes().to_vec()), &options)).err().unwrap();
        assert_eq!(error.diagnostic_code_json(), "\"RESOURCE_EXHAUSTED\"");
        assert!(error.original_stop().is_some());
    }
}
