// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use crate::lineage::*;
fn entry(base: &[&str], head: &[&str], relation: LineageRelation, shares: Option<Vec<f64>>) -> LineageEntry {
    LineageEntry { base: base.iter().map(|s| (*s).into()).collect(), head: head.iter().map(|s| (*s).into()).collect(), relation,
        reason: "reviewed".into(), shares }
}
#[test]
fn issue_8042_largest_share_tie_or_missing_evidence_orphans() {
    let mut lineage = Lineage { entries: vec![entry(&["old"], &["a","b"], LineageRelation::Split, Some(vec![0.5,0.5]))], deleted: vec!["deleted".into()] };
    let keys = vec!["old".into(),"deleted".into(),"unchanged".into()];
    let result = rekey_by_lineage(&keys, &lineage, RekeyPolicy::LargestShare);
    assert!(result[0].orphan);
    assert_eq!(result[1].relation, None);
    assert_eq!(result[2].relation, Some(RekeyRelation::Unchanged));
    lineage.entries[0].shares = Some(vec![0.4,0.6]);
    assert_eq!(rekey_by_lineage(&keys, &lineage, RekeyPolicy::LargestShare)[0].successors, ["b"]);
    lineage.entries[0].shares = None;
    assert!(rekey_by_lineage(&keys, &lineage, RekeyPolicy::LargestShare)[0].orphan);
    assert_eq!(rekey_by_lineage(&keys, &lineage, RekeyPolicy::CopyToAll)[0].successors, ["a","b"]);
}
#[test]
fn issue_8042_conflicting_aliases_abstain_instead_of_first_wins() {
    let entries = [entry(&["a"], &["target"], LineageRelation::Identity, None),
        entry(&["b"], &["target"], LineageRelation::Replaced, None),
        entry(&["c"], &["valid"], LineageRelation::Identity, None)];
    assert_eq!(key_aliases_from_lineage(&entries), [("valid".into(),"c".into())]);
    assert_eq!(lineage_conflicts(&entries), ["head key \"target\" appears in more than one lineage entry"]);
}
#[test]
fn issue_8042_merge_preserves_each_base_row_under_every_policy() {
    let lineage = Lineage { entries: vec![entry(&["a","b"], &["joined"], LineageRelation::Merge, Some(vec![0.4,0.6]))], deleted: vec![] };
    for policy in [RekeyPolicy::CopyToAll,RekeyPolicy::LargestShare,RekeyPolicy::OrphanOnSplit] {
        for result in rekey_by_lineage(&["a".into(),"b".into()], &lineage, policy) {
            assert_eq!(result.successors, ["joined"]);
            assert!(!result.orphan);
        }
    }
}
