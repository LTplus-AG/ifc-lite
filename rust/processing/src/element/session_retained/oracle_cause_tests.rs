// SPDX-License-Identifier: MPL-2.0
//! #7955 M5: each mutation has a preregistered assertion, not just a failed test.
use super::super::*;
use super::super::adversarial_tests::with_case;
use super::super::super::session_tests::SOURCE;

fn foreign_admission(report: bool) {
    with_case(None, SOURCE, |execution, decoder, router, worker, _, _| {
        let issued = execution.issue_next(decoder, router, worker).unwrap().unwrap();
        let work = issued.execute(worker, 0.001, 15., MeshLimits::default()).unwrap();
        let pointer = Arc::as_ptr(&work.realizations[0]);
        let pending = execution.pending.as_mut().unwrap();
        let PendingRetainedOperation::Construction { request, .. } = &mut pending.operations[0]
            else { panic!("fixture must issue construction"); };
        let RetainedRecipe::Extrusion(recipe) = request.recipe() else { panic!("fixture extrusion"); };
        let mut document = GeometryDocument::new();
        let definition = document.add_retained_extrusion(recipe.clone()).unwrap();
        *request = document.prepare_retained(definition, worker.incarnation()).unwrap();
        let Err(rejected) = execution.accept(work, decoder, router) else {
            panic!("M5_SOURCE_ADMISSION_GUARD accepted foreign source admission");
        };
        assert!(matches!(rejected.reason, RetainedExecutionError::Receipt(ReceiptFailure::ForeignSourceAdmission)));
        if report {
            assert_eq!(rejected.reason.code(), crate::retained_inspection_contract::Code::ReceiptInvalid,
                "M5_SOURCE_ADMISSION_REPORT");
        }
        assert_eq!(pointer, Arc::as_ptr(&rejected.work.realizations[0]));
        assert_eq!(execution.discharged_count(), 0);
        assert!(execution.pending.is_some());
    });
}
#[test]
fn issue_7955_source_admission_action_has_its_own_cause() { foreign_admission(false); }
#[test]
fn issue_7955_source_admission_report_has_its_own_cause() { foreign_admission(true); }
