// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Result transport contains row indices, never copied adapter references.
use crate::DocumentValue as Value;
macro_rules! json {
    ({$($key:literal : $value:expr),* $(,)?}) => {
        Value::Object(vec![$(($key.into(), json!($value))),*])
    };
    ($value:expr) => { crate::document_serde::to_document(&$value).expect("result DTO serialization") };
}
use crate::{engine::ModelDiff,model::{DiffScope,DiffState,DiffChangeKind},content_types::{ContentMatchKind,ContentMatchTier},
    split_types::{SplitMergeKind,SplitConfidence},successor::SuccessorConfidence};
pub fn result_to_document(diff: &ModelDiff<'_,usize>) -> Value {
    let core=&diff.core;
    let entries:Vec<_>=core.entries.iter().map(|e|{
        let state=match e.state {DiffState::Added=>"added",DiffState::Deleted=>"deleted",DiffState::Modified=>"modified",DiffState::Unchanged=>"unchanged"};
        let kinds:Vec<_>=e.change_kinds.iter().map(|k|match k {DiffChangeKind::Data=>"data",DiffChangeKind::Geometry=>"geometry",DiffChangeKind::Container=>"container"}).collect();
        let mut v=json!({"key":e.key,"state":state,"changeKinds":kinds});
        if let Some(base)=e.base {v["base"]=json!(base.reference);}
        if let Some(head)=e.head {v["head"]=json!(head.reference);}
        if let Some(keys)=&e.changed_components {v["changedComponents"]=json!(keys);}
        v
    }).collect();
    let mut result=json!({"scope":match core.scope {DiffScope::Data=>"data",DiffScope::Geometry=>"geometry",DiffScope::Both=>"both"},
        "excludedTypes":core.excluded_types,"entries":entries,
        "counts":json!({"added":core.counts.added,"modified":core.counts.modified,"deleted":core.counts.deleted,"unchanged":core.counts.unchanged})});
    if let Some(aliases)=&core.applied_key_aliases {result["appliedKeyAliases"]=json!(aliases);}
    if let Some(matches)=&diff.content_matches {
        result["contentMatches"]=json!(matches.iter().map(|m|{
            let kind=match m.kind {ContentMatchKind::Renamed=>"renamed",ContentMatchKind::Moved=>"moved",ContentMatchKind::Reshaped=>"reshaped",ContentMatchKind::Respecified=>"respecified",ContentMatchKind::Duplicated=>"duplicated",ContentMatchKind::Deduplicated=>"deduplicated",ContentMatchKind::Ambiguous=>"ambiguous"};
            let tier=match m.tier {ContentMatchTier::GeometryHash=>"geometry-hash",ContentMatchTier::GeometryOnly=>"geometry-only",ContentMatchTier::ResidueOneToOne=>"residue-1-1",ContentMatchTier::Positional=>"positional",ContentMatchTier::Unresolved=>"unresolved"};
            let mut v=json!({"kind":kind,"tier":tier,"dataHash":m.data_hash,"base":m.base.iter().map(|e|e.reference).collect::<Vec<_>>(),"head":m.head.iter().map(|e|e.reference).collect::<Vec<_>>()});
            if let Some(hash)=&m.geometry_hash {v["geometryHash"]=json!(hash);}
            if let Some(keys)=&m.changed_components {v["changedComponents"]=json!(keys);}
            if let Some(distance)=m.distance {v["distance"]=json!(distance);}
            v
        }).collect::<Vec<_>>());
    }
    if let Some(claims)=&diff.split_merges {
        result["splitMerges"]=json!(claims.iter().map(|c|{
            let kind=match c.kind {SplitMergeKind::Split=>"split",SplitMergeKind::Merge=>"merge"};
            let confidence=match c.confidence {SplitConfidence::Verified=>"verified",SplitConfidence::Extent=>"extent",SplitConfidence::Displaced=>"displaced"};
            let mut v=json!({"kind":kind,"confidence":confidence,"whole":c.whole.reference,"pieces":c.pieces.iter().map(|e|e.reference).collect::<Vec<_>>()});
            for (key,n) in [("wholeVolume",c.whole_volume),("piecesVolume",c.pieces_volume),("volumeResidual",c.volume_residual)] {if let Some(n)=n {v[key]=json!(n);}}
            if let Some(e)=c.excluded {v["excluded"]=json!(e.reference);}
            if c.cross_class {v["crossClass"]=json!(true);}
            v
        }).collect::<Vec<_>>());
    }
    if let Some(claims)=&diff.successors {
        result["successors"]=json!(claims.iter().map(|c|{
            let confidence=match c.confidence {SuccessorConfidence::Footprint=>"footprint",SuccessorConfidence::Position=>"position"};
            let mut v=json!({"confidence":confidence,"base":c.base.reference,"head":c.head.reference,"overlap":c.overlap,"distance":c.distance});
            if let Some(keys)=&c.agreeing_components {v["agreeingComponents"]=json!(keys);}
            if c.cross_class {v["crossClass"]=json!(true);}
            v
        }).collect::<Vec<_>>());
    }
    result
}
