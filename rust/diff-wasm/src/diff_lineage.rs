// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Direct lineage transport retains non-finite shares supplied by JS callers.
use ifc_lite_diff::lineage::{self, Lineage, LineageEntry, LineageRelation, RekeyPolicy, RekeyRelation};
use js_sys::JsString;
use serde::{de::Error as _, Deserialize, Deserializer, Serialize};
use wasm_bindgen::prelude::*;

// Staging only (#8081): inspect original JS code units before any Rust String
// conversion. U+FFFD is valid; an unpaired surrogate must never become U+FFFD.
const NON_SCALAR: &str = "WASM diff lineage requires well-formed UTF-16; use the public TypeScript lineage API for this input (#8042).";
fn scalar_string(value: JsString) -> Result<String, &'static str> {
    char::decode_utf16(value.iter()).collect::<Result<String, _>>().map_err(|_| NON_SCALAR)
}
struct ScalarString(String);
impl<'de> Deserialize<'de> for ScalarString {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let original: JsString = serde_wasm_bindgen::preserve::deserialize(deserializer)?;
        scalar_string(original).map(Self).map_err(D::Error::custom)
    }
}
fn string<'de, D: Deserializer<'de>>(deserializer: D) -> Result<String, D::Error> {
    ScalarString::deserialize(deserializer).map(|value| value.0)
}
fn strings<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Vec<String>, D::Error> {
    Vec::<ScalarString>::deserialize(deserializer).map(|values| values.into_iter().map(|value| value.0).collect())
}
fn entry_relation<'de, D: Deserializer<'de>>(deserializer: D) -> Result<LineageRelation, D::Error> {
    match string(deserializer)?.as_str() {
        "identity" => Ok(LineageRelation::Identity),
        "split" => Ok(LineageRelation::Split),
        "merge" => Ok(LineageRelation::Merge),
        "replaced" => Ok(LineageRelation::Replaced),
        _ => Err(D::Error::custom("Unknown lineage relation")),
    }
}
#[derive(Deserialize)]
struct Entry {
    #[serde(deserialize_with = "strings")]
    base: Vec<String>,
    #[serde(deserialize_with = "strings")]
    head: Vec<String>,
    #[serde(deserialize_with = "entry_relation")]
    relation: LineageRelation,
    #[serde(deserialize_with = "string")]
    reason: String,
    shares: Option<Vec<f64>>,
}
impl From<Entry> for LineageEntry {
    fn from(value: Entry) -> Self {
        Self { base: value.base.into_iter().map(Into::into).collect(),
            head: value.head.into_iter().map(Into::into).collect(), relation: value.relation,
            reason: value.reason.into(), shares: value.shares }
    }
}
fn entries(value: JsValue) -> Result<Vec<LineageEntry>, JsValue> {
    let values: Vec<Entry> = serde_wasm_bindgen::from_value(value).map_err(error)?;
    Ok(values.into_iter().map(Into::into).collect())
}
fn error(error: impl std::fmt::Display) -> JsValue { JsValue::from_str(&error.to_string()) }
fn output(value: impl Serialize) -> Result<JsValue, JsValue> {
    crate::diff_transport::to_value(value)
}

/// Return ordered conflict diagnostics for caller-supplied lineage entries.
#[wasm_bindgen(js_name = diffLineageConflicts)]
pub fn diff_lineage_conflicts(value: JsValue) -> Result<Vec<String>, JsValue> {
    // Staged scalar inputs imply scalar diagnostics; keep the existing ABI
    // until the operation-specific lossless observer replaces this guard (#8042).
    lineage::lineage_conflicts(&entries(value)?).into_iter().map(|value|
        value.as_str().map(str::to_owned).ok_or_else(|| JsValue::from_str(NON_SCALAR))).collect()
}

/// Return head/base pairs in JavaScript Map insertion order.
#[wasm_bindgen(js_name = diffKeyAliasesFromLineage)]
pub fn diff_key_aliases_from_lineage(value: JsValue) -> Result<JsValue, JsValue> {
    output(lineage::key_aliases_from_lineage(&entries(value)?))
}

#[derive(Serialize)]
struct RekeyRow {
    key: ifc_lite_diff::JsString, successors: Vec<ifc_lite_diff::JsString>, orphan: bool,
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
pub fn diff_rekey_by_lineage(keys: Vec<JsString>, value: JsValue, deleted: Vec<JsString>, policy: JsString) -> Result<JsValue, JsValue> {
    let keys = keys.into_iter().map(scalar_string).collect::<Result<Vec<_>, _>>().map_err(JsValue::from_str)?;
    let deleted = deleted.into_iter().map(scalar_string).collect::<Result<Vec<_>, _>>().map_err(JsValue::from_str)?;
    let policy = scalar_string(policy).map_err(JsValue::from_str)?;
    let policy = match policy.as_str() {
        "copy-to-all" => RekeyPolicy::CopyToAll,
        "largest-share" => RekeyPolicy::LargestShare,
        "orphan-on-split" => RekeyPolicy::OrphanOnSplit,
        _ => return Err(JsValue::from_str("Unknown rekey policy")),
    };
    let keys = keys.into_iter().map(Into::into).collect::<Vec<_>>();
    let deleted = deleted.into_iter().map(Into::into).collect();
    let lineage = Lineage { entries: entries(value)?, deleted };
    output(lineage::rekey_by_lineage(&keys, &lineage, policy).into_iter().map(|row| RekeyRow {
        key: row.key, successors: row.successors, orphan: row.orphan, relation: row.relation.map(relation),
    }).collect::<Vec<_>>())
}
