// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Creation, parsing, validation and serialization of lossless sidecar documents.
use std::collections::HashSet;
use std::fmt;
use crate::sidecar_value::{DocumentValue as Value, JsString};
use crate::sidecar_json;
pub use crate::sidecar_parse::parse_ordered_json;
use crate::sidecar_validation::{validate_identity_document, validate_lineage_document};

#[derive(Debug, Clone, Copy)]
pub enum SidecarKind { Identity, Lineage }
impl SidecarKind {
    fn format(self) -> &'static str { match self { Self::Identity => "ifc-lite/identity-map", Self::Lineage => "ifc-lite/lineage" } }
    fn label(self) -> &'static str { match self { Self::Identity => "identity-map", Self::Lineage => "lineage" } }
}
/// The JS boundary decodes this JSON string to retain any lone code units in
/// diagnostics. Display remains usable by native callers with scalar strings.
#[derive(Debug)]
pub struct SidecarDocumentError { message: JsString }
impl SidecarDocumentError {
    pub fn to_json(&self) -> String { serialize_sidecar(&Value::String(self.message.clone())) }
    fn validation(kind: SidecarKind, errors: Vec<JsString>) -> Self {
        let mut units: Vec<_> = format!("Invalid {} sidecar: ", kind.label()).encode_utf16().collect();
        for (index, error) in errors.iter().enumerate() {
            if index > 0 { units.extend("; ".encode_utf16()); }
            units.extend_from_slice(error.units());
        }
        Self { message: JsString::from_units(units) }
    }
}
impl fmt::Display for SidecarDocumentError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { fmt::Display::fmt(&self.message, f) }
}
impl std::error::Error for SidecarDocumentError {}
fn errors(value: &Value, kind: SidecarKind, valid_date: impl Fn(&str) -> bool) -> Vec<JsString> {
    match kind { SidecarKind::Identity => validate_identity_document(value, valid_date),
        SidecarKind::Lineage => validate_lineage_document(value, valid_date) }
}
fn validate(value: &Value, kind: SidecarKind, valid_date: impl Fn(&str) -> bool) -> Result<(), SidecarDocumentError> {
    let errors = errors(value, kind, valid_date);
    if errors.is_empty() { Ok(()) } else { Err(SidecarDocumentError::validation(kind, errors)) }
}
/// Ordered JS diagnostics as a lossless JSON value, suitable for host decoding.
pub fn validate_sidecar_document(value: &Value, kind: SidecarKind, valid_date: impl Fn(&str) -> bool) -> Value {
    Value::Array(errors(value, kind, valid_date).into_iter().map(Value::String).collect())
}
fn select(value: &Value, required: &[&str], optional: &[&str]) -> Value {
    let mut fields: Vec<_> = required.iter().map(|&key| (key.into(), value[key].clone())).collect();
    fields.extend(optional.iter().filter_map(|&key| value.get(key).map(|v| (key.into(), v.clone()))));
    Value::Object(fields)
}
fn key(value: &Value) -> &[u16] { value.as_string().map(JsString::units).unwrap_or(&[]) }
fn keys(value: &Value) -> Vec<Vec<u16>> {
    value.as_array().into_iter().flatten().map(|item| key(item).to_vec()).collect()
}
/// Native scalar callers retain the existing input and error types.
pub fn create_sidecar(init: &serde_json::Value, kind: SidecarKind, valid_date: impl Fn(&str) -> bool) -> Result<Value, String> {
    create_sidecar_document(&init.into(), kind, valid_date).map_err(|error| error.to_string())
}
/// Normalize and validate without projecting JS strings through scalar-only JSON.
pub fn create_sidecar_document(init: &Value, kind: SidecarKind, valid_date: impl Fn(&str) -> bool) -> Result<Value, SidecarDocumentError> {
    let lineage = matches!(kind, SidecarKind::Lineage);
    let Some(input) = init["entries"].as_array() else {
        return Err(SidecarDocumentError { message: format!("Invalid {} sidecar: entries must be an array", kind.label()).into() });
    };
    let mut seen = HashSet::new();
    let mut entries = vec![];
    for entry in input {
        // Structural tuples retain field/array boundaries and lossless UTF-16
        // keys, including delimiter code units (#8088). Provenance is first-wins.
        let signature = if lineage {
            (key(&entry["relation"]).to_vec(), keys(&entry["base"]), keys(&entry["head"]))
        } else {
            (key(&entry["base"]).to_vec(), vec![key(&entry["here"]).to_vec()], vec![])
        };
        if !seen.insert(signature) { continue; }
        entries.push(if lineage { select(entry, &["base", "head", "relation", "reason"], &["shares"]) }
            else { select(entry, &["base", "here", "reason"], &[]) });
    }
    entries.sort_by(|a, b| {
        let (ab, bb, ah, bh) = if lineage { (&a["base"][0], &b["base"][0], &a["head"][0], &b["head"][0]) }
            else { (&a["base"], &b["base"], &a["here"], &b["here"]) };
        key(ab).cmp(key(bb)).then_with(|| key(ah).cmp(key(bh)))
    });
    let mut fields = vec![
        ("format".into(), Value::String(kind.format().into())),
        ("version".into(), Value::Number(if init.get("keyProperty").is_some() { 2.0 } else { 1.0 })),
        ("base".into(), select(&init["base"], &["hash"], &["path"])),
        ("head".into(), select(&init["head"], &["hash"], &["path"])),
        ("entries".into(), Value::Array(entries)),
    ];
    if lineage {
        let mut seen = HashSet::new();
        let mut deleted: Vec<_> = init["deleted"].as_array().into_iter().flatten()
            .filter(|v| v.as_string().is_none_or(|s| seen.insert(s.clone()))).cloned().collect();
        deleted.sort_by(|a, b| key(a).cmp(key(b)));
        fields.push(("deleted".into(), Value::Array(deleted)));
    }
    for field in ["created", "keyProperty"] { if let Some(value) = init.get(field) { fields.push((field.into(), value.clone())); } }
    let result = Value::Object(fields);
    validate(&result, kind, valid_date)?;
    Ok(result)
}
/// Syntax diagnostics are host-specific; structural diagnostics retain their order.
pub fn parse_sidecar(text: &str, kind: SidecarKind, valid_date: impl Fn(&str) -> bool) -> Result<Value, String> {
    let value = parse_ordered_json(text).map_err(|e| format!("Invalid {} sidecar: not JSON ({e})", kind.label()))?;
    validate(&value, kind, valid_date).map_err(|error| error.to_string())?;
    Ok(value)
}
pub fn serialize_sidecar(value: &Value) -> String { sidecar_json::serialize(value) }
