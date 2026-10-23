// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use std::collections::{HashMap, HashSet};
use crate::content_types::{ContentMatch, ContentMatchKind};
use crate::successor::{SuccessorClaim, SuccessorConfidence};
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdentityMapEntry { pub base: String, pub here: String, pub reason: String }
pub const CONTENT_MATCH_REASON_PREFIX: &str = "content-match:";
pub const SUCCESSOR_REASON_PREFIX: &str = "successor:";
pub const ACCEPTED_AMBIGUOUS_REASON: &str = "accepted:ambiguous";

pub fn identity_map_from_content_matches<R>(matches: &[ContentMatch<'_, R>]) -> Vec<IdentityMapEntry> {
    matches.iter().filter_map(|m| {
        let name = match m.kind {
            ContentMatchKind::Renamed => "renamed", ContentMatchKind::Moved => "moved",
            ContentMatchKind::Reshaped => "reshaped", ContentMatchKind::Respecified => "respecified", _ => return None,
        };
        if m.base.len() != 1 || m.head.len() != 1 || m.base[0].key == m.head[0].key { return None; }
        Some(IdentityMapEntry { base: m.base[0].key.clone(), here: m.head[0].key.clone(), reason: format!("{CONTENT_MATCH_REASON_PREFIX}{name}") })
    }).collect()
}
/// Callers must explicitly choose the accepted successor claims; this is never
/// called automatically on the detector's suggestions.
pub fn identity_map_from_successors<R>(accepted: &[SuccessorClaim<'_, R>]) -> Vec<IdentityMapEntry> {
    let mut bases_by_here: HashMap<&str, HashSet<&str>> = HashMap::new();
    for claim in accepted {
        if claim.base.key != claim.head.key { bases_by_here.entry(&claim.head.key).or_default().insert(&claim.base.key); }
    }
    let mut seen = HashSet::new();
    accepted.iter().filter_map(|claim| {
        let base = &claim.base.key;
        let here = &claim.head.key;
        if base == here || bases_by_here.get(here.as_str()).is_some_and(|s| s.len() > 1) { return None; }
        if !seen.insert(format!("{base}\0{here}")) { return None; }
        let confidence = match claim.confidence { SuccessorConfidence::Footprint => "footprint", SuccessorConfidence::Position => "position" };
        Some(IdentityMapEntry { base: base.clone(), here: here.clone(), reason: format!("{SUCCESSOR_REASON_PREFIX}{confidence}") })
    }).collect()
}
