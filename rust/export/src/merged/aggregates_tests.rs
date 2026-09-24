// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use super::AggregationParents;

/// #5727: an already-parented member is stripped and the rest of the rel is
/// kept; a rel whose members are all parented is not written.
#[test]
fn strips_parented_members_and_drops_an_emptied_rel() {
    let mut parents = AggregationParents::default();
    let first = "#37=IFCRELAGGREGATES('a',$,$,$,#23,(#30));".to_string();
    assert_eq!(parents.claim(first.clone(), false), Some(first));
    let partial = "#1499=IFCRELAGGREGATES('b',$,$,$,#13,(#30,#1980));".to_string();
    assert_eq!(
        parents.claim(partial, true).as_deref(),
        Some("#1499=IFCRELAGGREGATES('b',$,$,$,#13,(#1980));")
    );
    let redundant = "#1500=IFCRELAGGREGATES('c',$,$,$,#13,(#30,#1980));".to_string();
    assert_eq!(parents.claim(redundant, true), None);
}

/// Without `dedupe` (the first model, a federated one) nothing is stripped,
/// but the members are still recorded for later models.
#[test]
fn records_without_stripping_when_not_deduping() {
    let mut parents = AggregationParents::default();
    let a = "#1=IFCRELAGGREGATES('a',$,$,$,#2,(#3));".to_string();
    let b = "#4=IFCRELAGGREGATES('b',$,$,$,#5,(#3));".to_string();
    assert_eq!(parents.claim(a, false).as_deref(), Some("#1=IFCRELAGGREGATES('a',$,$,$,#2,(#3));"));
    assert_eq!(parents.claim(b.clone(), false), Some(b));
    assert_eq!(parents.claim("#6=IFCRELAGGREGATES('c',$,$,$,#7,(#3));".to_string(), true), None);
}
