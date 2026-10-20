// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use super::*;
use crate::kernel::budget;

#[test]
fn incidence_work_is_separate_from_escalation_telemetry_7024() {
    with_limit(2, || {
        budget::begin();
        spend(1).unwrap(); spend(1).unwrap();
        assert!(!budget::tripped());
        assert!(spend(1).is_err());
        assert!(budget::tripped());
        assert_eq!(budget::count(), 0, "ordinary f64 work is not an exact escalation");
        assert!(spend(0).is_err(), "trip remains sticky within operation");
        budget::begin();
        assert!(!budget::tripped());
    });
}

#[test]
fn incidence_element_allowance_is_monotone_and_nested_scopes_restore_7024() {
    with_limit(OP_LIMIT, || {
        let _outer = budget::enter_element();
        for _ in 0..8 { budget::begin(); spend(OP_LIMIT as usize).unwrap(); }
        { let _nested = budget::enter_element(); budget::begin(); spend(1).unwrap(); }
        budget::begin();
        assert!(spend(1).is_err(), "new boolean cannot reset spent element work");
        assert!(budget::tripped());
    });
}
