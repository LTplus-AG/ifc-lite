// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Typed sidecar wire records. Validation and normalization are separate from
//! serialization, as in the TypeScript API.
use crate::identity_map::IdentityMapEntry;
use crate::lineage::{LineageEntry, LineageRelation};
use crate::sidecar_value::{DocumentValue as J, JsString};
use crate::sidecar_json;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelIdentity { pub hash: JsString, pub path: Option<JsString> }
#[derive(Debug, Clone)]
pub struct SidecarModels { pub base: ModelIdentity, pub head: ModelIdentity, pub key_property: Option<JsString> }
#[derive(Debug, Clone)]
pub struct IdentitySidecar { pub models: SidecarModels, pub version: u32, pub entries: Vec<IdentityMapEntry>, pub created: Option<JsString> }
#[derive(Debug, Clone)]
pub struct LineageSidecar { pub models: SidecarModels, pub version: u32, pub entries: Vec<LineageEntry>, pub deleted: Vec<JsString>, pub created: Option<JsString> }
fn string(value: impl Into<JsString>) -> J { J::String(value.into()) }
fn strings(values: &[JsString]) -> J { J::Array(values.iter().map(string).collect()) }
fn model(value: &ModelIdentity) -> J {
    let mut entries = vec![("hash".into(),string(&value.hash))];
    if let Some(path) = &value.path { entries.push(("path".into(),string(path))); }
    J::Object(entries)
}
fn header(format: &str, version: u32, models: &SidecarModels) -> Vec<(JsString, J)> {
    vec![("format".into(),string(format)),("version".into(),J::Number(version as f64)),
        ("base".into(),model(&models.base)),("head".into(),model(&models.head))]
}
fn suffix(entries: &mut Vec<(JsString, J)>, created: &Option<JsString>, models: &SidecarModels) {
    if let Some(created) = created { entries.push(("created".into(),string(created))); }
    if let Some(key) = &models.key_property { entries.push(("keyProperty".into(),string(key))); }
}
pub fn serialize_identity_sidecar(sidecar: &IdentitySidecar) -> String {
    let mut entries = header("ifc-lite/identity-map", sidecar.version, &sidecar.models);
    entries.push(("entries".into(),J::Array(sidecar.entries.iter().map(|e| J::Object(vec![
        ("base".into(),string(&e.base)),("here".into(),string(&e.here)),("reason".into(),string(&e.reason))])).collect())));
    suffix(&mut entries, &sidecar.created, &sidecar.models);
    sidecar_json::serialize(&J::Object(entries))
}
pub fn serialize_lineage_sidecar(sidecar: &LineageSidecar) -> String {
    let mut entries = header("ifc-lite/lineage", sidecar.version, &sidecar.models);
    entries.push(("entries".into(),J::Array(sidecar.entries.iter().map(|e| {
        let relation = match e.relation { LineageRelation::Identity => "identity", LineageRelation::Split => "split", LineageRelation::Merge => "merge", LineageRelation::Replaced => "replaced" };
        let mut value = vec![("base".into(),strings(&e.base)),("head".into(),strings(&e.head)),
            ("relation".into(),string(relation)),("reason".into(),string(&e.reason))];
        if let Some(shares) = &e.shares { value.push(("shares".into(),J::Array(shares.iter().map(|&n| J::Number(n)).collect()))); }
        J::Object(value)
    }).collect())));
    entries.push(("deleted".into(),strings(&sidecar.deleted)));
    suffix(&mut entries, &sidecar.created, &sidecar.models);
    sidecar_json::serialize(&J::Object(entries))
}
pub fn pinned_model_mismatches(pinned: &SidecarModels, models: &SidecarModels, artifact: &str) -> Vec<JsString> {
    let mut problems = vec![];
    for (side, a, b) in [("base", &pinned.base, &models.base),("head", &pinned.head, &models.head)] {
        if a.hash != b.hash { problems.push(JsString::concat(&[&format!("{side} model does not match the {artifact} ({artifact} ").into(), &a.hash, &", got ".into(), &b.hash, &")".into()], "")); }
    }
    if pinned.key_property.as_ref().filter(|s| !s.is_empty()) != models.key_property.as_ref().filter(|s| !s.is_empty()) {
        let default: JsString = "GlobalId".into();
        problems.push(JsString::concat(&[&format!("key scheme does not match the {artifact} ({artifact} ").into(),
            pinned.key_property.as_ref().unwrap_or(&default), &", got ".into(),
            models.key_property.as_ref().unwrap_or(&default), &")".into()], ""));
    }
    problems
}
