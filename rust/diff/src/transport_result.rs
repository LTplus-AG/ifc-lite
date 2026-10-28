// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Result transport contains row indices, never copied adapter references.
use crate::DocumentValue as Value;
// Fixed protocol vocabulary is immutable. Share its UTF-16 storage across rows.
macro_rules! text {
    ($value:literal) => {{
        static VALUE: std::sync::OnceLock<crate::JsString> = std::sync::OnceLock::new();
        VALUE.get_or_init(|| $value.into()).clone()
    }};
}
macro_rules! json {
    ({$($key:literal : $value:expr),* $(,)?}) => {
        Value::Object(vec![$((text!($key), json!($value))),*])
    };
    ($value:expr) => { crate::document_serde::to_document(&$value).expect("result DTO serialization") };
}
use crate::{engine::ModelDiff,model::{DiffScope,DiffState,DiffChangeKind},content_types::{ContentMatchKind,ContentMatchTier},
    split_types::{SplitMergeKind,SplitConfidence},successor::SuccessorConfidence};
pub fn result_to_document(diff: &ModelDiff<'_,usize>) -> Value {
    let core=&diff.core;
    let entries = Value::Array(core.entries.iter().map(entry_document).collect());
    // Already-built documents must move into the envelope. Serializing them
    // through serde again re-allocates every row, key and UTF-16 value (#8042).
    let mut result = Value::Object(vec![
        (text!("scope"), json!(match core.scope {DiffScope::Data=>"data",DiffScope::Geometry=>"geometry",DiffScope::Both=>"both"})),
        (text!("excludedTypes"), strings(&core.excluded_types)),
        (text!("entries"), entries),
        (text!("counts"), json!({"added":core.counts.added,"modified":core.counts.modified,"deleted":core.counts.deleted,"unchanged":core.counts.unchanged})),
    ]);
    if let Some(aliases)=&core.applied_key_aliases {result["appliedKeyAliases"]=json!(aliases);}
    if let Some(matches)=&diff.content_matches {
        result["contentMatches"]=Value::Array(matches.iter().map(|m|{
            let kind=match m.kind {ContentMatchKind::Renamed=>"renamed",ContentMatchKind::Moved=>"moved",ContentMatchKind::Reshaped=>"reshaped",ContentMatchKind::Respecified=>"respecified",ContentMatchKind::Duplicated=>"duplicated",ContentMatchKind::Deduplicated=>"deduplicated",ContentMatchKind::Ambiguous=>"ambiguous"};
            let tier=match m.tier {ContentMatchTier::GeometryHash=>"geometry-hash",ContentMatchTier::GeometryOnly=>"geometry-only",ContentMatchTier::ResidueOneToOne=>"residue-1-1",ContentMatchTier::Positional=>"positional",ContentMatchTier::Unresolved=>"unresolved"};
            let mut v=json!({"kind":kind,"tier":tier,"dataHash":m.data_hash,"base":m.base.iter().map(|e|e.reference).collect::<Vec<_>>(),"head":m.head.iter().map(|e|e.reference).collect::<Vec<_>>()});
            if let Some(hash)=&m.geometry_hash {v["geometryHash"]=json!(hash);}
            if let Some(keys)=&m.changed_components {v["changedComponents"]=json!(keys);}
            if let Some(distance)=m.distance {v["distance"]=json!(distance);}
            v
        }).collect());
    }
    if let Some(claims)=&diff.split_merges {
        result["splitMerges"]=Value::Array(claims.iter().map(|c|{
            let kind=match c.kind {SplitMergeKind::Split=>"split",SplitMergeKind::Merge=>"merge"};
            let confidence=match c.confidence {SplitConfidence::Verified=>"verified",SplitConfidence::Extent=>"extent",SplitConfidence::Displaced=>"displaced"};
            let mut v=json!({"kind":kind,"confidence":confidence,"whole":c.whole.reference,"pieces":c.pieces.iter().map(|e|e.reference).collect::<Vec<_>>()});
            for (key,n) in [("wholeVolume",c.whole_volume),("piecesVolume",c.pieces_volume),("volumeResidual",c.volume_residual)] {if let Some(n)=n {v[key]=json!(n);}}
            if let Some(e)=c.excluded {v["excluded"]=json!(e.reference);}
            if c.cross_class {v["crossClass"]=json!(true);}
            v
        }).collect());
    }
    if let Some(claims)=&diff.successors {
        result["successors"]=Value::Array(claims.iter().map(|c|{
            let confidence=match c.confidence {SuccessorConfidence::Footprint=>"footprint",SuccessorConfidence::Position=>"position"};
            let mut v=json!({"confidence":confidence,"base":c.base.reference,"head":c.head.reference,"overlap":c.overlap,"distance":c.distance});
            if let Some(keys)=&c.agreeing_components {v["agreeingComponents"]=json!(keys);}
            if c.cross_class {v["crossClass"]=json!(true);}
            v
        }).collect());
    }
    result
}

fn strings(values: &[crate::JsString]) -> Value {
    Value::Array(values.iter().cloned().map(Value::String).collect())
}

fn entry_document(entry: &crate::model::DiffEntry<'_, usize>) -> Value {
    let state = match entry.state {
        DiffState::Added => text!("added"), DiffState::Deleted => text!("deleted"),
        DiffState::Modified => text!("modified"), DiffState::Unchanged => text!("unchanged"),
    };
    let kinds = entry.change_kinds.iter().map(|kind| Value::String(match kind {
        DiffChangeKind::Data => text!("data"), DiffChangeKind::Geometry => text!("geometry"),
        DiffChangeKind::Container => text!("container"),
    })).collect();
    let mut fields = Vec::with_capacity(6);
    fields.push((text!("key"), Value::String(entry.key.clone())));
    fields.push((text!("state"), Value::String(state)));
    fields.push((text!("changeKinds"), Value::Array(kinds)));
    if let Some(base) = entry.base { fields.push((text!("base"), Value::Number(base.reference as f64))); }
    if let Some(head) = entry.head { fields.push((text!("head"), Value::Number(head.reference as f64))); }
    if let Some(keys) = &entry.changed_components { fields.push((text!("changedComponents"), strings(keys))); }
    Value::Object(fields)
}
