// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::*;

#[test]
fn first_wins_and_the_conflict_is_recorded() {
    let mut a = TypeAssignments::new();
    assert_eq!(a.record(10, 1), Recorded::First);
    assert_eq!(a.record(10, 1), Recorded::Same);
    assert_eq!(a.record(11, 2), Recorded::First);
    assert_eq!(a.record(10, 3), Recorded::NewConflict);
    assert_eq!(a.record(10, 4), Recorded::Conflict);
    assert_eq!(a.record(10, 3), Recorded::Conflict);
    assert_eq!(a.type_of(10), Some(1));
    assert_eq!(a.candidates(10), [1, 3, 4]);
    assert_eq!(a.candidates(11), [2]);
    assert_eq!(a.conflicts(), [(10, vec![1, 3, 4])]);
    assert!(a.is_conflicted(10) && !a.is_conflicted(11));
    assert_eq!(a.unambiguous().collect::<Vec<_>>(), [(11, 2)]);
}

#[test]
fn conflicts_come_in_the_order_they_were_first_seen() {
    let mut a = TypeAssignments::new();
    for (o, t) in [(5, 1), (6, 1), (6, 2), (5, 2)] {
        a.record(o, t);
    }
    assert_eq!(a.conflicts(), [(6, vec![1, 2]), (5, vec![1, 2])]);
}
