// SPDX-License-Identifier: MPL-2.0
//! Unwind invariant: caller, accepted source and reached numerical evidence stay ordered.
use super::{PendingReports, UnwindReports};
use crate::{construction::ConstructionReports, processors::diagnostic_capture};
use ifc_lite_core::IfcType;
use std::{panic::{catch_unwind, AssertUnwindSafe}, sync::Arc};

fn reports(face: IfcType) -> ConstructionReports {
    ConstructionReports { face_refused: vec![face], ..Default::default() }
}

#[test]
fn unwind_restores_caller_then_source_then_numerical_reports_once() {
    let _ = crate::processors::take_face_refused();
    diagnostic_capture::restore(&reports(IfcType::IfcFace));
    let pending = PendingReports::new(reports(IfcType::IfcAdvancedFace));
    let payload = Arc::new(String::from("original numerical panic"));
    let panic = catch_unwind(AssertUnwindSafe(|| {
        diagnostic_capture::capture(|| {
            let _prefix = UnwindReports(pending.clone());
            diagnostic_capture::restore(&reports(IfcType::IfcFaceSurface));
            std::panic::panic_any(Arc::clone(&payload));
        });
    })).expect_err("the original panic propagates");
    let panic = panic.downcast::<Arc<String>>().expect("original panic type");
    assert!(Arc::ptr_eq(&payload, &panic));
    assert_eq!(crate::processors::take_face_refused(), [
        IfcType::IfcFace, IfcType::IfcAdvancedFace, IfcType::IfcFaceSurface,
    ]);
    assert!(pending.take().face_refused.is_empty(), "unwind consumes the source handoff");
    assert!(crate::processors::take_face_refused().is_empty());
}
