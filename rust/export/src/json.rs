// SPDX-License-Identifier: MPL-2.0
//! Structured **JSON** exporter — an array of entity objects with native fields,
//! property sets and quantity sets. A faithful dump of the shared export model that
//! preserves value types (numbers stay numbers, booleans stay booleans).

use serde_json::{json, Map, Value};

use crate::model::{build_export_model, EntityRow, PropValue};

/// Options for JSON export.
pub struct JsonOptions {
    /// Pretty-print with indentation.
    pub pretty: bool,
    /// Include property sets.
    pub include_properties: bool,
    /// Include quantity sets.
    pub include_quantities: bool,
}

impl Default for JsonOptions {
    fn default() -> Self {
        Self { pretty: false, include_properties: true, include_quantities: true }
    }
}

/// Coerce a rendered property value to a typed JSON value using its IFC type tag.
pub(crate) fn typed_value(p: &PropValue) -> Value {
    match p.value_type.as_str() {
        "IFCREAL" | "IFCINTEGER" | "IFCNUMBER" | "IFCLENGTHMEASURE" | "IFCAREAMEASURE"
        | "IFCVOLUMEMEASURE" | "IFCPOSITIVELENGTHMEASURE" | "IFCCOUNTMEASURE"
        | "IFCMASSMEASURE" | "IFCRATIOMEASURE" | "IFCNORMALISEDRATIOMEASURE" => {
            p.value.parse::<f64>().map(|n| json!(n)).unwrap_or_else(|_| json!(p.value))
        }
        "IFCBOOLEAN" | "IFCLOGICAL" => match p.value.as_str() {
            "true" => json!(true),
            "false" => json!(false),
            other => json!(other),
        },
        _ => json!(p.value),
    }
}

fn entity_to_json(e: &EntityRow, opts: &JsonOptions) -> Value {
    let mut obj = Map::new();
    obj.insert("expressId".into(), json!(e.express_id));
    obj.insert("type".into(), json!(e.ifc_type));
    if let Some(g) = &e.global_id {
        obj.insert("globalId".into(), json!(g));
    }
    if let Some(n) = &e.name {
        obj.insert("name".into(), json!(n));
    }
    if let Some(d) = &e.description {
        obj.insert("description".into(), json!(d));
    }
    if let Some(o) = &e.object_type {
        obj.insert("objectType".into(), json!(o));
    }
    obj.insert("hasGeometry".into(), json!(e.has_geometry));

    if opts.include_properties && !e.property_sets.is_empty() {
        let psets: Vec<Value> = e
            .property_sets
            .iter()
            .map(|ps| {
                let props: Vec<Value> = ps
                    .properties
                    .iter()
                    .map(|p| json!({ "name": p.name, "value": typed_value(p), "type": p.value_type }))
                    .collect();
                json!({ "name": ps.name, "properties": props })
            })
            .collect();
        obj.insert("propertySets".into(), json!(psets));
    }

    if opts.include_quantities && !e.quantity_sets.is_empty() {
        let qsets: Vec<Value> = e
            .quantity_sets
            .iter()
            .map(|qs| {
                let quants: Vec<Value> = qs
                    .quantities
                    .iter()
                    .map(|q| json!({ "name": q.name, "value": q.value, "type": q.kind }))
                    .collect();
                json!({ "name": qs.name, "quantities": quants })
            })
            .collect();
        obj.insert("quantitySets".into(), json!(qsets));
    }

    Value::Object(obj)
}

/// Export the model as a JSON array string.
pub fn export_json(content: &[u8], opts: &JsonOptions) -> String {
    let model = build_export_model(content);
    let arr: Vec<Value> = model.entities.iter().map(|e| entity_to_json(e, opts)).collect();
    let value = Value::Array(arr);
    if opts.pretty {
        serde_json::to_string_pretty(&value).expect("json serializes")
    } else {
        serde_json::to_string(&value).expect("json serializes")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(rel: &str) -> Vec<u8> {
        let path = format!("{}/../../tests/models/{}", env!("CARGO_MANIFEST_DIR"), rel);
        std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"))
    }

    #[test]
    fn duplex_exports_json_array() {
        let s = export_json(&fixture("ara3d/duplex.ifc"), &JsonOptions::default());
        let v: Value = serde_json::from_str(&s).expect("valid JSON");
        let arr = v.as_array().expect("array");
        assert!(arr.len() > 50);
        let first = &arr[0];
        assert!(first["expressId"].is_number());
        assert!(first["type"].is_string());
        assert!(first["hasGeometry"].is_boolean());

        // A property's value preserves its type (some number-valued property is a JSON number).
        let has_typed_number = arr.iter().any(|e| {
            e["propertySets"].as_array().is_some_and(|ps| {
                ps.iter().any(|p| {
                    p["properties"].as_array().is_some_and(|props| {
                        props.iter().any(|pr| pr["value"].is_number() || pr["value"].is_boolean())
                    })
                })
            })
        });
        assert!(has_typed_number, "expected at least one typed (number/bool) property value");
    }
}
