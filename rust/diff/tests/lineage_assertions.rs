// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use ifc_lite_diff::{lineage::*, identity_map::*, model::KeyDiff, content_types::ContentMatch,
    split_types::SplitMergeClaim, successor::SuccessorClaim};
use serde_json::{json, Value};
fn relation(r: LineageRelation) -> &'static str {
    match r { LineageRelation::Identity => "identity", LineageRelation::Split => "split", LineageRelation::Merge => "merge", LineageRelation::Replaced => "replaced" }
}
fn identity(entries: Vec<IdentityMapEntry>) -> Value {
    json!(entries.iter().map(|e| json!({"base":e.base,"here":e.here,"reason":e.reason})).collect::<Vec<_>>())
}
pub fn assert_lineage(vector: &Value, core: &KeyDiff<'_, Value>, matches: &[ContentMatch<'_, Value>],
    splits: &[SplitMergeClaim<'_, Value>], successors: &[SuccessorClaim<'_, Value>]) {
    if vector.get("expectedLineage").is_none() { return; }
    let accepted = if vector["accept"] == true { successors } else { &[] };
    let mut provenance = AliasProvenance::default();
    for pair in vector["aliasReasons"].as_array().into_iter().flatten() {
        provenance.reasons.insert(pair[0].as_str().unwrap().into(), pair[1].as_str().unwrap().into());
    }
    for pair in vector["aliasRelations"].as_array().into_iter().flatten() {
        provenance.relations.insert(pair[0].as_str().unwrap().into(), if pair[1] == "identity" { LineageRelation::Identity } else { LineageRelation::Replaced });
    }
    let lineage = lineage_of_diff(core, matches, splits, accepted, &provenance);
    let entries: Vec<_> = lineage.entries.iter().map(|e| {
        let mut out = json!({"base":e.base,"head":e.head,"relation":relation(e.relation),"reason":e.reason});
        if let Some(shares) = &e.shares {
            out["shares"] = json!(shares.iter().map(|&n| serde_json::from_str::<Value>(ryu_js::Buffer::new().format(n)).unwrap()).collect::<Vec<_>>());
        }
        out
    }).collect();
    let keys: Vec<String> = serde_json::from_value(vector["keys"].clone()).unwrap();
    let mut rekey = json!({});
    for (name, policy) in [("copy-to-all",RekeyPolicy::CopyToAll),("largest-share",RekeyPolicy::LargestShare),("orphan-on-split",RekeyPolicy::OrphanOnSplit)] {
        rekey[name] = json!(rekey_by_lineage(&keys, &lineage, policy).iter().map(|r| {
            let mut out = json!({"key":r.key,"successors":r.successors,"orphan":r.orphan});
            if let Some(kind) = r.relation { out["relation"] = json!(match kind { RekeyRelation::Unchanged => "unchanged", RekeyRelation::Changed(kind) => relation(kind) }); }
            out
        }).collect::<Vec<_>>());
    }
    let actual = json!({"lineage":{"entries":entries,"deleted":lineage.deleted},
        "conflicts":lineage_conflicts(&lineage.entries),"aliases":key_aliases_from_lineage(&lineage.entries),
        "identity":identity(identity_map_from_content_matches(matches)),"accepted":identity(identity_map_from_successors(accepted)),"rekey":rekey});
    assert_eq!(actual, vector["expectedLineage"], "lineage case {}", vector["name"]);
}
