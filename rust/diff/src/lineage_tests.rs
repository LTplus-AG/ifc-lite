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
        let results = rekey_by_lineage(&["a".into(),"b".into()], &lineage, policy);
        assert_eq!(results.iter().map(|r| r.key.as_str().unwrap()).collect::<Vec<_>>(), ["a", "b"]);
        for result in results {
            assert_eq!(result.successors, ["joined"]);
            assert!(!result.orphan);
        }
    }
}

#[test]
fn issue_8042_alias_lookup_keeps_first_seen_order_and_abstains_on_conflicts() {
    let entries = [entry(&["base-z"], &["z"], LineageRelation::Identity, None),
        entry(&["base-a"], &["a"], LineageRelation::Replaced, None),
        entry(&["base-z"], &["z"], LineageRelation::Identity, None),
        entry(&["other"], &["a"], LineageRelation::Identity, None),
        entry(&["self"], &["self"], LineageRelation::Identity, None),
        entry(&["base-b"], &["b"], LineageRelation::Identity, None)];
    assert_eq!(key_aliases_from_lineage(&entries), [("z".into(), "base-z".into()), ("b".into(), "base-b".into())]);
}
#[test]
fn issue_8042_rekey_conflicting_entries_preserves_typescript_first_entry_contract() {
    // packages/diff/src/lineage.ts fills byBase only when the key is absent.
    // Conflict diagnostics are separate; the faithful port must not change rekey policy.
    let lineage = Lineage { entries: vec![entry(&["a"], &["b"], LineageRelation::Replaced, None),
        entry(&["a"], &["c"], LineageRelation::Replaced, None)], deleted: vec![] };
    assert!(!lineage_conflicts(&lineage.entries).is_empty());
    for policy in [RekeyPolicy::CopyToAll, RekeyPolicy::LargestShare, RekeyPolicy::OrphanOnSplit] {
        let results = rekey_by_lineage(&["a".into()], &lineage, policy);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].successors, ["b"]);
    }
}

#[test]
fn issue_8084_largest_share_requires_valid_unambiguous_evidence() {
    let cases = [None, Some(vec![]), Some(vec![0.6]), Some(vec![0.2, 0.6, 0.2]),
        Some(vec![f64::NAN, 0.6]), Some(vec![0.6, f64::NAN]),
        Some(vec![f64::INFINITY, 0.6]), Some(vec![0.6, f64::INFINITY]),
        Some(vec![f64::NEG_INFINITY, 0.6]), Some(vec![0.6, f64::NEG_INFINITY]),
        Some(vec![-0.1, 0.6]), Some(vec![0.6, -0.1]), Some(vec![0.5, 0.5]), Some(vec![0.0, 0.0])];
    for shares in cases {
        let lineage = Lineage { entries: vec![entry(&["source"], &["a", "b"], LineageRelation::Split, shares)], deleted: vec![] };
        assert_eq!(rekey_by_lineage(&["source".into()], &lineage, RekeyPolicy::LargestShare), [RekeyResult {
            key: "source".into(), successors: vec![], relation: Some(RekeyRelation::Changed(LineageRelation::Split)), orphan: true,
        }]);
        assert_eq!(rekey_by_lineage(&["source".into()], &lineage, RekeyPolicy::CopyToAll)[0].successors, ["a", "b"]);
    }
    for shares in [vec![0.0, 1.0], vec![2.0, 6.0], vec![0.4, 0.6]] {
        let lineage = Lineage { entries: vec![entry(&["source"], &["a", "b"], LineageRelation::Split, Some(shares))], deleted: vec![] };
        let result = rekey_by_lineage(&["source".into()], &lineage, RekeyPolicy::LargestShare);
        assert_eq!(result[0].successors, ["b"]);
        assert!(!result[0].orphan);
    }
}
