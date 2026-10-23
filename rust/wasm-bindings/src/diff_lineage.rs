// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Direct lineage transport retains non-finite shares supplied by JS callers.
use ifc_lite_diff::lineage::{self, Lineage, LineageEntry, LineageRelation, RekeyPolicy, RekeyRelation};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum Relation { Identity, Split, Merge, Replaced }
impl From<Relation> for LineageRelation {
    fn from(value: Relation) -> Self {
        match value { Relation::Identity => Self::Identity, Relation::Split => Self::Split,
            Relation::Merge => Self::Merge, Relation::Replaced => Self::Replaced }
    }
}
#[derive(Deserialize)]
struct Entry {
    base: Vec<String>, head: Vec<String>, relation: Relation, reason: String,
    shares: Option<Vec<f64>>,
}
impl From<Entry> for LineageEntry {
    fn from(value: Entry) -> Self {
        Self { base: value.base, head: value.head, relation: value.relation.into(),
            reason: value.reason, shares: value.shares }
    }
}
fn entries(value: JsValue) -> Result<Vec<LineageEntry>, JsValue> {
    let values: Vec<Entry> = serde_wasm_bindgen::from_value(value).map_err(error)?;
    Ok(values.into_iter().map(Into::into).collect())
}
fn error(error: impl std::fmt::Display) -> JsValue { JsValue::from_str(&error.to_string()) }
fn output(value: impl Serialize) -> Result<JsValue, JsValue> {
    value.serialize(&serde_wasm_bindgen::Serializer::json_compatible()).map_err(error)
}

/// Return ordered conflict diagnostics for caller-supplied lineage entries.
#[wasm_bindgen(js_name = diffLineageConflicts)]
pub fn diff_lineage_conflicts(value: JsValue) -> Result<Vec<String>, JsValue> {
    Ok(lineage::lineage_conflicts(&entries(value)?))
}

/// Return head/base pairs in JavaScript Map insertion order.
#[wasm_bindgen(js_name = diffKeyAliasesFromLineage)]
pub fn diff_key_aliases_from_lineage(value: JsValue) -> Result<JsValue, JsValue> {
    output(lineage::key_aliases_from_lineage(&entries(value)?))
}

#[derive(Serialize)]
struct RekeyRow {
    key: String, successors: Vec<String>, orphan: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    relation: Option<&'static str>,
}
fn relation(value: RekeyRelation) -> &'static str {
    match value {
        RekeyRelation::Unchanged => "unchanged",
        RekeyRelation::Changed(LineageRelation::Identity) => "identity",
        RekeyRelation::Changed(LineageRelation::Split) => "split",
        RekeyRelation::Changed(LineageRelation::Merge) => "merge",
        RekeyRelation::Changed(LineageRelation::Replaced) => "replaced",
    }
}
/// Migrate keys using Rust policies, preserving the absence of orphan relations.
#[wasm_bindgen(js_name = diffRekeyByLineage)]
pub fn diff_rekey_by_lineage(keys: Vec<String>, value: JsValue, deleted: Vec<String>, policy: &str) -> Result<JsValue, JsValue> {
    let policy = match policy {
        "copy-to-all" => RekeyPolicy::CopyToAll,
        "largest-share" => RekeyPolicy::LargestShare,
        "orphan-on-split" => RekeyPolicy::OrphanOnSplit,
        _ => return Err(JsValue::from_str("Unknown rekey policy")),
    };
    let lineage = Lineage { entries: entries(value)?, deleted };
    output(lineage::rekey_by_lineage(&keys, &lineage, policy).into_iter().map(|row| RekeyRow {
        key: row.key, successors: row.successors, orphan: row.orphan, relation: row.relation.map(relation),
    }).collect::<Vec<_>>())
}
