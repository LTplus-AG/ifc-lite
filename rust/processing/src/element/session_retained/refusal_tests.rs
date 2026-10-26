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
}
#[test]
fn issue_7955_contract_breach_runtime_and_logical() {
    check(
        RetainedExecutionError::Geometry(ifc_lite_geometry::Error::geometry(
            "conflicting retained numerical outcome",
        )),
        Refusal::ContractBreach,
        "contract_breach",
    );
    check(
        fault(RuntimeFaultKind::Contract),
        Refusal::ContractBreach,
        "contract_breach",
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

// Refs #7955: the Common classification depends on typed causes, never error prose.
#[test]
fn issue_7955_common_refusal_rows_and_stop_precedence() {
    use super::refusal::common_kind_refusal;
    use ifc_lite_geometry::program::transactions::TransactionFailureKind as Kind;
    for (kind, expected) in [
        (Kind::Source, Refusal::SourceInvalid),
        (Kind::Unsupported, Refusal::SourceInvalid),
        (Kind::Incomplete, Refusal::Incomplete),
        (Kind::Stopped, Refusal::ResourceExhausted),
        (Kind::DeadlineExceeded, Refusal::DeadlineExceeded),
    ] {
        assert_eq!(common_kind_refusal(kind, None), expected, "{kind:?}");
    }
    assert_eq!(
        common_kind_refusal(Kind::Stopped, Some(resource::overflow())),
        Refusal::ResourceExhausted
    );
    assert_eq!(
        common_kind_refusal(Kind::Stopped, Some(ProgramStop::Cancelled)),
        Refusal::Cancelled
    );
}

#[test]
fn issue_7955_common_incomplete_is_observed_from_unfinished_traversal() {
    let mut decoder = EntityDecoder::new(super::super::session_tests::SOURCE);
    let entity = decoder.decode_by_id(10).unwrap();
    let error = RetainedTraversal::new(1, 1)
        .product_parts(&entity)
        .finish()
        .err()
        .unwrap();
    check(
        RetainedExecutionError::Common(error),
        Refusal::Incomplete,
        "incomplete",
    );
}

#[test]
fn issue_7955_common_source_invalid_preserves_the_source_origin() {
    let mut decoder = EntityDecoder::new("#1=IFCWALL('w',$,$,$,$,$,#99,$,$);");
    let router = GeometryRouter::new();
    let entity = decoder.decode_by_id(1).unwrap();
    let mut program = RetainedTraversal::new(1, 1).product_parts(&entity);
    while let Some(ticket) = program.request().unwrap() {
        let (reply, _, _storage) = program.admit(ticket, &router, &mut decoder).unwrap();
        program
            .accept(reply, &router)
            .unwrap_or_else(|e| panic!("{:?}", e.error));
    }
    let error = RetainedExecutionError::Common(program.finish().err().unwrap());
    let (refusal, origin) = error.refusal();
    assert_eq!(refusal, Refusal::SourceInvalid);
    assert!(origin.is_some());
}

fn controller_failure() -> TransactionError {
    // A real directrix walk reaches the cooperative source checkpoint and
    // propagates its typed failure through common traversal completion.
    let text = super::super::session_tests::SOURCE.replace(
        "#13=IFCEXTRUDEDAREASOLID(#14,#5,#15,3.);",
        "#13=IFCSWEPTDISKSOLID(#53,0.2,$,$,$);",
    );
    let mut decoder = EntityDecoder::new(&text);
    let router = GeometryRouter::new();
    let entity = decoder.decode_by_id(10).unwrap();
    let mut program = RetainedTraversal::new(1, 1).product_parts(&entity);
    loop {
        let ticket = match program.request() {
            Ok(Some(ticket)) => ticket,
            Ok(None) => break,
            Err(error) => return error,
        };
        let (reply, _, _storage) = match program.admit(ticket, &router, &mut decoder) {
            Ok(admission) => admission,
            Err(error) => return error,
        };
        if let Err(error) = program.accept(reply, &router) {
            return error.error;
        }
    }
    program
        .finish()
        .err()
        .expect("the scoped source walk must refuse")
}

#[test]
fn issue_7955_common_resource_stop_without_cancel() {
    let account = resource::ExecutionAccount::new(resource::ExecutionPolicy::Bounded(
        resource::ResourceLimits {
            work: Some(0),
            ..Default::default()
        },
    ));
    let error = account.scope(controller_failure);
    check(
        RetainedExecutionError::Common(error),
        Refusal::ResourceExhausted,
        "resource_exhausted",
    );
}

#[test]
fn issue_7955_common_deadline_survives_scope_exit() {
    let budget =
        resource::ProductBudget::new(resource::BudgetStart::now(), 1_000_000, 1_000_000, 0);
    let error = budget.scope(controller_failure);
    check(
        RetainedExecutionError::Common(error),
        Refusal::DeadlineExceeded,
        "deadline_exceeded",
    );
}
