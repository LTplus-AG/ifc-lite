// SPDX-License-Identifier: MPL-2.0
//! `authoredEntityRefs` and `recordRefs`: the entity references an authored
//! (JSON) value names, and those of an extracted-or-authored slot.

use serde_json::Value;

use super::jsval::JsVal;
use super::readers::authored_entity_refs;

/// `authoredEntityRefs`: a `"#N"` string, or the strings of a list.
pub(crate) fn authored_refs(value: &Value) -> Vec<u32> {
    match value {
        Value::Array(items) => items.iter().flat_map(authored_refs).collect(),
        Value::String(s) => authored_entity_refs(s),
        _ => Vec::new(),
    }
}

/// A slot of an effective record: the extractor's value, or an authored one.
#[derive(Debug, Clone)]
pub(crate) enum Slot {
    Source(JsVal),
    Authored(Value),
}

/// `recordRefs`: extractor numbers are references, authored values use `#N`.
pub(crate) fn record_refs(slot: &Slot) -> Vec<u32> {
    fn source(v: &JsVal) -> Vec<u32> {
        match v {
            JsVal::Num(n) => vec![*n as u32],
            JsVal::Arr(items) => items.iter().flat_map(source).collect(),
            JsVal::Str(s) => authored_entity_refs(s),
            JsVal::Null => Vec::new(),
        }
    }
    fn authored(v: &Value) -> Vec<u32> {
        match v {
            Value::Number(n) => n.as_f64().map(|f| vec![f as u32]).unwrap_or_default(),
            Value::Array(items) => items.iter().flat_map(authored).collect(),
            Value::String(s) => authored_entity_refs(s),
            _ => Vec::new(),
        }
    }
    match slot {
        Slot::Source(v) => source(v),
        Slot::Authored(v) => authored(v),
    }
}
