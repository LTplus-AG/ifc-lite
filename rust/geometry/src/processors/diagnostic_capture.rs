// SPDX-License-Identifier: MPL-2.0
//! Isolate an owned planning/execution capture without stealing its caller's TLS.
use crate::construction::ConstructionReports;

fn take() -> ConstructionReports {
    ConstructionReports { curve_capped: super::take_curve_capped(),
        face_refused: super::take_face_refused(), decoder_refused_record_ids: Vec::new() }
}

pub(crate) fn restore(reports: &ConstructionReports) {
    super::advanced_face::restore_reports(reports.curve_capped, &reports.face_refused);
}

struct Scope(Option<ConstructionReports>);
impl Scope {
    fn finish(mut self) -> ConstructionReports {
        let captured = take();
        restore(&self.0.take().expect("active capture"));
        captured
    }
}
impl Drop for Scope {
    fn drop(&mut self) {
        if let Some(saved) = self.0.take() {
            let during_unwind = take();
            restore(&saved);
            restore(&during_unwind);
        }
    }
}

pub(crate) fn capture<T>(operation: impl FnOnce() -> T) -> (T, ConstructionReports) {
    let scope = Scope(Some(take()));
    let result = operation();
    (result, scope.finish())
}
