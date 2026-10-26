// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Native output DTOs and operation-specific live lineage observations.
use ifc_lite_diff::JsString;
use ifc_lite_diff::lineage::{LineageEntry, LineageRelation};
#[path = "diff_lineage_observe.rs"]
mod observe;
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Relation { Identity, Split, Merge, Replaced }
impl From<Relation> for LineageRelation {
    fn from(value: Relation) -> Self {
        match value { Relation::Identity => Self::Identity, Relation::Split => Self::Split,
            Relation::Merge => Self::Merge, Relation::Replaced => Self::Replaced }
    }
}
#[derive(Deserialize, Serialize)]
pub(super) struct Entry {
    base: Vec<JsString>, head: Vec<JsString>, relation: Relation, reason: JsString,
    #[serde(skip_serializing_if = "Option::is_none")]
    shares: Option<Vec<f64>>,
}
impl From<Entry> for LineageEntry {
    fn from(value: Entry) -> Self {
        Self { base: value.base, head: value.head, relation: value.relation.into(),
            reason: value.reason, shares: value.shares }
    }
}
impl From<LineageEntry> for Entry {
    fn from(value: LineageEntry) -> Self {
        let relation = match value.relation { LineageRelation::Identity => Relation::Identity,
            LineageRelation::Split => Relation::Split, LineageRelation::Merge => Relation::Merge,
            LineageRelation::Replaced => Relation::Replaced };
        Self { base: value.base, head: value.head, relation, reason: value.reason, shares: value.shares }
    }
}
pub(super) fn output(value: impl Serialize) -> Result<JsValue, JsValue> {
    crate::diff_transport::to_value(value)
}

/// Return ordered conflict diagnostics for caller-supplied lineage entries.
#[wasm_bindgen(js_name = diffLineageConflicts, unchecked_return_type = "string[]")]
pub fn diff_lineage_conflicts(value: JsValue) -> Result<JsValue, JsValue> {
    observe::conflicts(&value)
}

/// Return head/base pairs in JavaScript Map insertion order.
#[wasm_bindgen(js_name = diffKeyAliasesFromLineage)]
pub fn diff_key_aliases_from_lineage(value: JsValue) -> Result<JsValue, JsValue> {
    observe::aliases(&value)
}

/// Migrate keys while observing only the selected entries and policy fields.
#[wasm_bindgen(js_name = diffRekeyByLineage)]
pub fn diff_rekey_by_lineage(keys: JsValue, value: JsValue, deleted: JsValue, policy: &str) -> Result<JsValue, JsValue> {
    observe::rekey(&keys, &value, &deleted, policy)
}
