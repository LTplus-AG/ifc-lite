// SPDX-License-Identifier: MPL-2.0
//! #7955: every preregistered refusal row has an executable mapping check.
use super::super::session_protocol::WorkError;
use super::refusal::RetainedProductRefusal as Refusal;
use super::runtime::{RuntimeFault, RuntimeFaultKind};
use super::*;

fn check(error: RetainedExecutionError, expected: Refusal, code: &str) {
    let (actual, origin) = error.refusal();
    assert_eq!(actual, expected);
    assert_eq!(actual.code(), code);
    assert!(origin.is_none());
}
fn fault(kind: RuntimeFaultKind) -> RetainedExecutionError {
    RuntimeFault {
        kind,
        message: "arbitrary text must not classify the fault".into(),
    }
    .into()
}

#[test]
fn issue_7955_opening_strategy() {
    check(
        RetainedExecutionError::Unsupported(Unsupported::RetainedOpeningStrategy),
        Refusal::OpeningStrategy,
        "opening_strategy",
    );
}
#[test]
fn issue_7955_material_layer_strategy() {
    check(
        RetainedExecutionError::Unsupported(Unsupported::RetainedMaterialLayerStrategy),
        Refusal::MaterialLayerStrategy,
        "material_layer_strategy",
    );
}
#[test]
fn issue_7955_operation_unsupported() {
    check(
        RetainedExecutionError::Recipe(
            ifc_lite_geometry::document::RetainedRefusal::UnsupportedSource("unsupported".into()),
        ),
        Refusal::OperationUnsupported,
        "operation_unsupported",
    );
    for reason in [
        Unsupported::ConstructionRecipe,
        Unsupported::RetainedStrategy,
    ] {
        check(
            RetainedExecutionError::Unsupported(reason),
            Refusal::OperationUnsupported,
            "operation_unsupported",
        );
    }
}
#[test]
fn issue_7955_source_invalid() {
    check(
        RetainedExecutionError::Recipe(
            ifc_lite_geometry::document::RetainedRefusal::InvalidSource("invalid"),
        ),
        Refusal::SourceInvalid,
        "source_invalid",
    );
    check(
        RetainedExecutionError::Core(ifc_lite_core::Error::InvalidEntityRef(99)),
        Refusal::SourceInvalid,
        "source_invalid",
    );
    check(
        RetainedExecutionError::InvalidTypeSource,
        Refusal::SourceInvalid,
        "source_invalid",
    );
}
#[test]
fn issue_7955_source_changed() {
    for reason in [
        RetainedContextError::Missing,
        RetainedContextError::Stale,
        RetainedContextError::Mismatched,
    ] {
        check(
            RetainedExecutionError::Source(reason),
            Refusal::SourceChanged,
            "source_changed",
        );
    }
    check(
        RetainedExecutionError::Owner(WorkError::StaleSource),
        Refusal::SourceChanged,
        "source_changed",
    );
}
#[test]
fn issue_7955_incomplete() {
    check(
        RetainedExecutionError::Unsupported(
            Unsupported::RetainedFinalPublicationRequiresOpeningLayerAppearanceFaceProofs,
        ),
        Refusal::Incomplete,
        "incomplete",
    );
}
#[test]
fn issue_7955_empty_result() {
    check(
        RetainedExecutionError::Receipt(ReceiptFailure::EmptyConstructionResult),
        Refusal::EmptyResult,
        "empty_result",
    );
}
#[test]
fn issue_7955_family_unqualified() {
    check(
        fault(RuntimeFaultKind::Unqualified),
        Refusal::FamilyUnqualified,
        "family_unqualified",
    );
}
#[test]
fn issue_7955_kernel_failure_retains_status() {
    for status in [1, 8, -17] {
        check(
            fault(RuntimeFaultKind::Kernel { status }),
            Refusal::KernelFailure { status },
            "kernel_failure",
        );
    }
}
#[test]
fn issue_7955_worker_fault() {
    check(
        fault(RuntimeFaultKind::Transport),
        Refusal::WorkerFault,
        "worker_fault",
    );
    check(
        RetainedExecutionError::Geometry(ifc_lite_geometry::Error::geometry("transport")),
        Refusal::WorkerFault,
        "worker_fault",
    );
}
#[test]
fn issue_7955_worker_retired() {
    check(
        fault(RuntimeFaultKind::Retired),
        Refusal::WorkerRetired,
        "worker_retired",
    );
    check(
        RetainedExecutionError::DomainRetired,
        Refusal::WorkerRetired,
        "worker_retired",
    );
}
#[test]
fn issue_7955_resource_exhausted() {
    check(
        fault(RuntimeFaultKind::ResourceLimit),
        Refusal::ResourceExhausted,
        "resource_exhausted",
    );
    check(
        RetainedExecutionError::Stopped(resource::overflow()),
        Refusal::ResourceExhausted,
        "resource_exhausted",
    );
}
#[test]
fn issue_7955_deadline_exceeded() {
    check(
        RetainedExecutionError::DeadlineExceeded,
        Refusal::DeadlineExceeded,
        "deadline_exceeded",
    );
}
#[test]
fn issue_7955_cancelled() {
    check(
        RetainedExecutionError::Stopped(ProgramStop::Cancelled),
        Refusal::Cancelled,
        "cancelled",
    );
    check(
        RetainedExecutionError::Transition(CANCELLED),
        Refusal::Cancelled,
        "cancelled",
    );
}
#[test]
fn issue_7955_contract_breach() {
    for reason in [
        ReceiptFailure::InvalidRetainedNumericalLimits,
        ReceiptFailure::ForeignSourceAdmission,
        ReceiptFailure::NumericalResultKindMismatch,
    ] {
        check(
            RetainedExecutionError::Receipt(reason),
            Refusal::ContractBreach,
            "contract_breach",
        );
    }
    for reason in [
        WorkError::WrongOwner,
        WorkError::OwnerBusy,
        WorkError::WrongPayload,
    ] {
        check(
            RetainedExecutionError::Owner(reason),
            Refusal::ContractBreach,
            "contract_breach",
        );
    }
    check(
        RetainedExecutionError::Transition(DELIVERED),
        Refusal::ContractBreach,
        "contract_breach",
    );
}

#[test]
fn issue_7955_common_origin_survives_refusal_mapping() {
    // A real IFC unsupported product is refused by the common controller before
    // any numerical invocation. The structured origin must survive the boundary.
    let mut decoder = EntityDecoder::new("#1=IFCALIGNMENT('a',$,$,$,$,$,$,$,$);");
    let entity = decoder.decode_by_id(1).unwrap();
    let program = RetainedTraversal::new(1, 1).product_parts(&entity);
    let error = program.finish().err().expect("unsupported product");
    let (refusal, origin) = RetainedExecutionError::Common(error).refusal();
    assert_eq!(refusal, Refusal::OperationUnsupported);
    assert_eq!(
        origin,
        Some(super::refusal::RefusalOrigin {
            site: "product_root",
            entity: Some(1),
            cause: "structure"
        })
    );
}
