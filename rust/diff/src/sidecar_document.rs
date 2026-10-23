// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//! Creation, parsing and serialization of ordered sidecar documents.
use std::collections::HashSet;
use serde_json::{Map, Value};
use crate::js_json::JsonValue;
use crate::sidecar_json;
pub use crate::sidecar_parse::parse_ordered_json;
use crate::sidecar_validation::{validate_identity_sidecar, validate_lineage_sidecar};
use crate::utf16::cmp_code_units;

#[derive(Debug, Clone, Copy)]
pub enum SidecarKind { Identity, Lineage }
impl SidecarKind {
    fn format(self) -> &'static str { match self { Self::Identity => "ifc-lite/identity-map",Self::Lineage => "ifc-lite/lineage" } }
    fn label(self) -> &'static str { match self { Self::Identity => "identity-map",Self::Lineage => "lineage" } }
}
fn validate(value: &Value, kind: SidecarKind, valid_date: impl Fn(&str)->bool) -> Result<(),String> {
    let errors = match kind { SidecarKind::Identity=>validate_identity_sidecar(value,valid_date),SidecarKind::Lineage=>validate_lineage_sidecar(value,valid_date) };
    if errors.is_empty() { Ok(()) } else { Err(format!("Invalid {} sidecar: {}",kind.label(),errors.join("; "))) }
}
fn select(value: &Value, required: &[&str], optional: &[&str]) -> Value {
    let mut out = Map::new();
    for &key in required { out.insert(key.into(),value[key].clone()); }
    for &key in optional { if let Some(value) = value.get(key) { out.insert(key.into(),value.clone()); } }
    Value::Object(out)
}
fn key(value: &Value) -> &str { value.as_str().unwrap_or("") }
/// Typed callers supply the same init fields as the TS create functions.
/// First occurrence wins for a duplicate claim, including its reason/shares.
pub fn create_sidecar(init: &Value, kind: SidecarKind, valid_date: impl Fn(&str)->bool) -> Result<JsonValue,String> {
    let lineage = matches!(kind,SidecarKind::Lineage);
    let Some(input) = init["entries"].as_array() else { return Err(format!("Invalid {} sidecar: entries must be an array",kind.label())); };
    let mut seen = HashSet::new();
    let mut entries = vec![];
    for entry in input {
        let signature = if lineage {
            let join = |v: &Value| v.as_array().map(|a|a.iter().map(key).collect::<Vec<_>>().join("\u{1}")).unwrap_or_default();
            format!("{}\0{}\0{}",key(&entry["relation"]),join(&entry["base"]),join(&entry["head"]))
        } else { format!("{}\0{}",key(&entry["base"]),key(&entry["here"])) };
        if !seen.insert(signature) { continue; }
        entries.push(if lineage { select(entry,&["base","head","relation","reason"],&["shares"]) }
            else { select(entry,&["base","here","reason"],&[]) });
    }
    entries.sort_by(|a,b| {
        let (ab,bb,ah,bh) = if lineage { (&a["base"][0],&b["base"][0],&a["head"][0],&b["head"][0]) }
            else { (&a["base"],&b["base"],&a["here"],&b["here"]) };
        cmp_code_units(key(ab),key(bb)).then_with(||cmp_code_units(key(ah),key(bh)))
    });
    let mut out = Map::new();
    out.insert("format".into(),Value::String(kind.format().into()));
    out.insert("version".into(),Value::from(if init.get("keyProperty").is_some() {2}else{1}));
    for side in ["base","head"] { out.insert(side.into(),select(&init[side],&["hash"],&["path"])); }
    out.insert("entries".into(),Value::Array(entries));
    if lineage {
        let mut seen = HashSet::new();
        let mut deleted: Vec<_> = init["deleted"].as_array().into_iter().flatten().filter(|v|seen.insert((*v).clone())).cloned().collect();
        deleted.sort_by(|a,b|cmp_code_units(key(a),key(b)));
        out.insert("deleted".into(),Value::Array(deleted));
    }
    for field in ["created","keyProperty"] { if let Some(value)=init.get(field) {out.insert(field.into(),value.clone());} }
    let out = Value::Object(out);
    validate(&out,kind,valid_date)?;
    let mut fields = vec![
        ("format".into(), wire_value(&out["format"])),
        ("version".into(), wire_value(&out["version"])),
    ];
    for field in ["base", "head"] {
        fields.push((field.into(), ordered_fields(&out[field], &["hash", "path"])));
    }
    let entry_fields: &[&str] = if lineage { &["base", "head", "relation", "reason", "shares"] }
        else { &["base", "here", "reason"] };
    fields.push(("entries".into(), JsonValue::Array(out["entries"].as_array().unwrap().iter()
        .map(|entry| ordered_fields(entry, entry_fields)).collect())));
    for field in ["deleted", "created", "keyProperty"] {
        if let Some(value) = out.get(field) { fields.push((field.into(), wire_value(value))); }
    }
    Ok(JsonValue::Object(fields))
}
fn ordered_fields(value: &Value, fields: &[&str]) -> JsonValue {
    JsonValue::Object(fields.iter().filter_map(|&field| value.get(field)
        .map(|v| (field.into(), wire_value(v)))).collect())
}
/// Parsing preserves extra fields and object insertion order. Structural errors
/// use the same ordered error list as the JS API; syntax diagnostics originate
/// in the host JSON parser and are not a stable cross-runtime message contract.
pub fn parse_sidecar(text: &str, kind: SidecarKind, valid_date: impl Fn(&str)->bool) -> Result<JsonValue,String> {
    let value: Value = serde_json::from_str(text).map_err(|e|format!("Invalid {} sidecar: not JSON ({e})",kind.label()))?;
    validate(&value,kind,valid_date)?;
    parse_ordered_json(text).map_err(|e|format!("Invalid {} sidecar: not JSON ({e})",kind.label()))
}
fn array_index(key: &str) -> Option<u32> {
    let index = key.parse::<u32>().ok()?;
    (index != u32::MAX && index.to_string() == key).then_some(index)
}
fn wire_value(value: &Value) -> JsonValue {
    match value {
        Value::Null=>JsonValue::Null,Value::Bool(b)=>JsonValue::Bool(*b),
        Value::Number(n)=>JsonValue::Number(n.as_f64().unwrap()),Value::String(s)=>JsonValue::String(s.clone()),
        Value::Array(a)=>JsonValue::Array(a.iter().map(wire_value).collect()),
        Value::Object(o)=>{
            // JS enumeration promotes canonical array-index names, even on an
            // object parsed from text. Other names keep insertion order.
            let mut entries: Vec<_> = o.iter().collect();
            entries.sort_by(|a,b| match (array_index(a.0),array_index(b.0)) {
                (Some(a),Some(b))=>a.cmp(&b),(Some(_),None)=>std::cmp::Ordering::Less,
                (None,Some(_))=>std::cmp::Ordering::Greater,_=>std::cmp::Ordering::Equal,
            });
            JsonValue::Object(entries.into_iter().map(|(k,v)|(k.clone(),wire_value(v))).collect())
        }
    }
}
pub fn serialize_sidecar(value: &JsonValue) -> String { sidecar_json::serialize(value) }
