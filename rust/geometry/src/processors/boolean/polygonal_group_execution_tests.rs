// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;
use crate::kernel::arrangement::issue_7292_fixtures::{bottom_cutter_7292, cut0_cutter_7292, cut0_host_7292};
use crate::kernel::budget;
use crate::mesh_check::ClosureVerdict;

/// #7982: in the default build, a per-cutter trial's failure records decide
/// whether the #3925 removal bound stays valid, and so whether a rejected or
/// torn grouped cut may try the moved-cutter repair. The open-topology record
/// used to key its 0.1 mm grid in raw caller units, so on this millimetre
/// group (the #7292 captured operands, `length_unit_scale` 0.001) the first
/// trial's micron-scale consolidation gaps read as a tear and invalidated the
/// bound. They are not a tear at 0.1 mm, so the bound must stay valid: repair
/// eligibility follows the real closure verdict.
#[test]
fn issue_7982_micron_gap_trials_keep_the_3925_repair_eligible_in_millimetres() {
    let _caps = budget::GLOBAL_CAP_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let _element = budget::enter_element();
    let host = cut0_host_7292();
    let prisms = [cut0_cutter_7292(), bottom_cutter_7292()];
    let clipper = ClippingProcessor::with_unit_scale(0.001);
    let mut bound = polygonal_removal::RemovalBound::new(&host);
    let mut trials = Vec::new();
    for prism in &prisms {
        let trial = BooleanClippingProcessor::subtract_checked(&clipper, &host, prism)
            .expect("each trial cut is accepted");
        let failures = clipper.take_failures();
        assert!(failures.is_empty(), "a micron-gap trial is not a tear: {failures:?}");
        bound.observe(&trial);
        trials.push(trial);
    }
    // Premise: the first trial really carries the gaps the old keying misread.
    assert!(!ClosureVerdict::for_mesh(&trials[0]).closed_enough_to_emit(), "open on the raw 1e-4 grid");
    assert!(ClosureVerdict::for_mesh_in_units(&trials[0], 0.001).closed_enough_to_emit(), "closed at 0.1 mm");
    assert!(bound.is_valid(), "clean trials keep the #3925 repair eligible");

    match BooleanClippingProcessor::new().execute_polygonal_group(&host, &prisms, 0.001) {
        GroupExecution::Clipped { failures, .. } => {
            assert!(failures.is_empty(), "the grouped cut records no tear: {failures:?}")
        }
        GroupExecution::Defer => panic!("the grouped cut deferred"),
        GroupExecution::UnionUnavailable(f) => panic!("the cutter union was unavailable: {f:?}"),
    }
}
