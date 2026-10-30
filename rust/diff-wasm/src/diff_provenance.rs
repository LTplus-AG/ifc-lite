// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Pure identity/lineage projection. Adapter references never enter this DTO.
use std::collections::HashMap;
use ifc_lite_diff::JsString;
use ifc_lite_diff::{
    content_types::{ContentMatch, ContentMatchKind, ContentMatchTier},
    identity_map::{self, IdentityMapEntry},
    lineage::{self, AliasProvenance, LineageRelation},
    model::{DiffEntry, DiffScope, DiffState, EntityFingerprint, KeyDiff},
    split_types::{SplitConfidence, SplitMergeClaim, SplitMergeKind},
    successor::{SuccessorClaim, SuccessorConfidence},
};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;
use crate::diff_lineage::{Entry, output};

#[derive(Deserialize)]
struct EntityFields { key: JsString, volume: Option<f64> }
#[derive(Deserialize)]
#[serde(from = "EntityFields")]
struct Entity(EntityFingerprint<()>);
impl From<EntityFields> for Entity {
    fn from(value: EntityFields) -> Self {
        // These operations inspect only identity and proved piece volumes;
        // geometry, fingerprint hashes and opaque references stay in JS.
        Self(EntityFingerprint { key: value.key, volume: value.volume,
            ifc_type: JsString::default(), data_hash: JsString::default(), geometry_hash: None,
            aabb: None, components: None, container: None, reference: () })
    }
}
#[derive(Deserialize)]
struct Match { kind: JsString, base: Vec<Entity>, head: Vec<Entity> }
impl Match {
    fn native(&self) -> ContentMatch<'_, ()> {
        let kind = match self.kind.as_str() {
            Some("renamed") => ContentMatchKind::Renamed, Some("moved") => ContentMatchKind::Moved,
            Some("reshaped") => ContentMatchKind::Reshaped, Some("respecified") => ContentMatchKind::Respecified,
            Some("duplicated") => ContentMatchKind::Duplicated, Some("deduplicated") => ContentMatchKind::Deduplicated,
            _ => ContentMatchKind::Ambiguous,
        };
        ContentMatch { kind, tier: ContentMatchTier::Unresolved, data_hash: JsString::default(),
            geometry_hash: None, changed_components: None, distance: None,
            base: self.base.iter().map(|e| &e.0).collect(), head: self.head.iter().map(|e| &e.0).collect() }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum SuccessorEvidence { Footprint, Position }
#[derive(Deserialize)]
struct Accepted { base: Entity, head: Entity, confidence: SuccessorEvidence }
impl Accepted {
    fn native(&self) -> SuccessorClaim<'_, ()> {
        SuccessorClaim { base: &self.base.0, head: &self.head.0,
            confidence: match self.confidence { SuccessorEvidence::Footprint => SuccessorConfidence::Footprint,
                SuccessorEvidence::Position => SuccessorConfidence::Position },
            overlap: 0.0, distance: 0.0, agreeing_components: None, cross_class: false }
    }
}
#[derive(Serialize)]
struct Identity { base: JsString, here: JsString, reason: JsString }
impl From<IdentityMapEntry> for Identity {
    fn from(value: IdentityMapEntry) -> Self { Self { base: value.base, here: value.here, reason: value.reason } }
}
fn identities(values: Vec<IdentityMapEntry>) -> Result<JsValue, JsValue> {
    output(values.into_iter().map(Identity::from).collect::<Vec<_>>())
}
/// Derive only committed one-to-one content identities, preserving input order.
#[wasm_bindgen(js_name = diffIdentityMapFromContentMatches)]
pub fn diff_identity_map_from_content_matches(value: JsValue) -> Result<JsValue, JsValue> {
    let values: Vec<Match> = crate::diff_transport::from_value(value)?;
    identities(identity_map::identity_map_from_content_matches(&values.iter().map(Match::native).collect::<Vec<_>>()))
}
/// Derive identities only from explicitly accepted successor suggestions.
#[wasm_bindgen(js_name = diffIdentityMapFromSuccessors)]
pub fn diff_identity_map_from_successors(value: JsValue) -> Result<JsValue, JsValue> {
    let values: Vec<Accepted> = crate::diff_transport::from_value(value)?;
    identities(identity_map::identity_map_from_successors(&values.iter().map(Accepted::native).collect::<Vec<_>>()))
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum State { Added, Modified, Deleted, Unchanged }
#[derive(Deserialize)]
struct Row { key: JsString, state: State }
impl Row {
    fn native(&self) -> DiffEntry<'_, ()> {
        DiffEntry { key: self.key.clone(), state: match self.state {
            State::Added => DiffState::Added, State::Modified => DiffState::Modified,
            State::Deleted => DiffState::Deleted, State::Unchanged => DiffState::Unchanged },
            change_kinds: vec![], base: None, head: None, changed_components: None }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum SplitKind { Split, Merge }
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum SplitEvidence { Verified, Extent, Displaced }
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Split {
    kind: SplitKind, confidence: SplitEvidence, whole: Entity, pieces: Vec<Entity>, pieces_volume: Option<f64>,
}
impl Split {
    fn native(&self) -> SplitMergeClaim<'_, ()> {
        SplitMergeClaim { kind: match self.kind { SplitKind::Split => SplitMergeKind::Split, SplitKind::Merge => SplitMergeKind::Merge },
            confidence: match self.confidence { SplitEvidence::Verified => SplitConfidence::Verified,
                SplitEvidence::Extent => SplitConfidence::Extent, SplitEvidence::Displaced => SplitConfidence::Displaced },
            whole: &self.whole.0, pieces: self.pieces.iter().map(|e| &e.0).collect(), pieces_volume: self.pieces_volume,
            whole_volume: None, volume_residual: None, excluded: None, cross_class: false }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Diff {
    entries: Vec<Row>, applied_key_aliases: Option<Vec<(JsString, JsString)>>,
    #[serde(default)] content_matches: Vec<Match>,
    #[serde(default)] split_merges: Vec<Split>,
}
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum AliasRelation { Identity, Replaced }
#[derive(Serialize)]
struct Lineage { entries: Vec<Entry>, deleted: Vec<JsString> }
/// Assemble lineage with the same native logic used for native comparisons.
#[wasm_bindgen(js_name = diffLineageOfDiff)]
pub fn diff_lineage_of_diff(value: JsValue, accepted: JsValue, reasons: JsValue, relations: JsValue) -> Result<JsValue, JsValue> {
    let value: Diff = crate::diff_transport::from_value(value)?;
    let accepted: Vec<Accepted> = crate::diff_transport::from_value(accepted)?;
    let reasons: Vec<(JsString, JsString)> = crate::diff_transport::from_value(reasons)?;
    let relations: Vec<(JsString, AliasRelation)> = crate::diff_transport::from_value(relations)?;
    let core = KeyDiff { strip_placement_geometry: false, scope: DiffScope::Both, excluded_types: vec![], entries: value.entries.iter().map(Row::native).collect(),
        by_key: HashMap::new(), counts: Default::default(), applied_key_aliases: value.applied_key_aliases, use_geometry: true };
    let provenance = AliasProvenance { reasons: reasons.into_iter().collect(), relations: relations.into_iter().map(|(key, relation)|
        (key, match relation { AliasRelation::Identity => LineageRelation::Identity, AliasRelation::Replaced => LineageRelation::Replaced })).collect() };
    let result = lineage::lineage_of_diff(&core, &value.content_matches.iter().map(Match::native).collect::<Vec<_>>(),
        &value.split_merges.iter().map(Split::native).collect::<Vec<_>>(),
        &accepted.iter().map(Accepted::native).collect::<Vec<_>>(), &provenance);
    output(Lineage { entries: result.entries.into_iter().map(Entry::from).collect(), deleted: result.deleted })
}
