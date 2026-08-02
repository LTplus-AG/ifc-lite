// SPDX-License-Identifier: MPL-2.0
//! **JSON-LD** exporter for semantic-web interop. Ports
//! `packages/export/src/jsonld-exporter.ts`: an `@graph` of `ifc:`-prefixed nodes
//! with `hasPropertySets` / `hasQuantitySets`, against the buildingSMART IFC4 OWL vocab.

use serde_json::{json, Value};

use crate::json::typed_value;
use crate::model::build_export_model;

const DEFAULT_CONTEXT: &str = "https://standards.buildingsmart.org/IFC/DEV/IFC4/ADD2/OWL";

/// Options for JSON-LD export.
pub struct JsonLdOptions {
    /// Ontology context IRI (default buildingSMART IFC4 ADD2 OWL).
    pub context: String,
    pub include_properties: bool,
    pub include_quantities: bool,
    pub pretty: bool,
    /// Express-id isolation filter (mirrors the OBJ/glTF/STEP exporters): when
    /// non-empty, only these entities are emitted into `@graph`; empty ⇒ all.
    pub included: Vec<u32>,
}

impl Default for JsonLdOptions {
    fn default() -> Self {
        Self {
            context: DEFAULT_CONTEXT.to_string(),
            include_properties: true,
            include_quantities: false,
            pretty: false,
            included: Vec::new(),
        }
    }
}

/// Export the model as a JSON-LD document string.
pub fn export_jsonld(content: &[u8], opts: &JsonLdOptions) -> String {
    let model = build_export_model(content);
    let filter: Option<std::collections::HashSet<u32>> = if opts.included.is_empty() {
        None
    } else {
        Some(opts.included.iter().copied().collect())
    };
    let mut graph: Vec<Value> = Vec::with_capacity(model.entities.len());

    for e in &model.entities {
        if let Some(set) = &filter {
            if !set.contains(&e.express_id) {
                continue;
            }
        }
        let mut node = serde_json::Map::new();
        node.insert("@id".into(), json!(format!("ifc:{}", e.express_id)));
        node.insert("@type".into(), json!(format!("ifc:{}", e.ifc_type)));
        node.insert("ifc:expressId".into(), json!(e.express_id));
        if let Some(g) = &e.global_id {
            node.insert("ifc:globalId".into(), json!(g));
        }
        if let Some(n) = &e.name {
            node.insert("ifc:name".into(), json!(n));
        }

        if opts.include_properties && !e.property_sets.is_empty() {
            let psets: Vec<Value> = e
                .property_sets
                .iter()
                .map(|ps| {
                    let props: Vec<Value> = ps
                        .properties
                        .iter()
                        .map(|p| {
                            json!({
                                "@type": "ifc:IfcPropertySingleValue",
                                "ifc:name": p.name,
                                "ifc:nominalValue": typed_value(p),
                            })
                        })
                        .collect();
                    json!({ "@type": "ifc:IfcPropertySet", "ifc:name": ps.name, "ifc:hasProperties": props })
                })
                .collect();
            node.insert("ifc:hasPropertySets".into(), json!(psets));
        }

        if opts.include_quantities && !e.quantity_sets.is_empty() {
            let qsets: Vec<Value> = e
                .quantity_sets
                .iter()
                .map(|qs| {
                    let quants: Vec<Value> = qs
                        .quantities
                        .iter()
                        .map(|q| {
                            json!({
                                "@type": format!("ifc:IfcQuantity{}", q.kind),
                                "ifc:name": q.name,
                                "ifc:value": q.value,
                            })
                        })
                        .collect();
                    json!({ "@type": "ifc:IfcElementQuantity", "ifc:name": qs.name, "ifc:quantities": quants })
                })
                .collect();
            node.insert("ifc:hasQuantitySets".into(), json!(qsets));
        }

        graph.push(Value::Object(node));
    }

    let doc = json!({
        "@context": { "@vocab": format!("{}#", opts.context), "ifc": format!("{}#", opts.context) },
        "@graph": graph,
    });
    if opts.pretty {
        serde_json::to_string_pretty(&doc).expect("jsonld serializes")
    } else {
        serde_json::to_string(&doc).expect("jsonld serializes")
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
    fn duplex_exports_valid_jsonld() {
        let s = export_jsonld(&fixture("ara3d/duplex.ifc"), &JsonLdOptions::default());
        let v: Value = serde_json::from_str(&s).expect("valid JSON");
        assert!(v["@context"]["ifc"].as_str().unwrap().ends_with("OWL#"));
        let graph = v["@graph"].as_array().expect("graph array");
        assert!(graph.len() > 50);
        let first = &graph[0];
        assert!(first["@id"].as_str().unwrap().starts_with("ifc:"));
        assert!(first["@type"].as_str().unwrap().starts_with("ifc:Ifc"));

        // At least one node carries property sets in the ifc: namespace.
        let has_psets = graph.iter().any(|n| n["ifc:hasPropertySets"].is_array());
        assert!(has_psets, "expected ifc:hasPropertySets somewhere");
    }

    #[test]
    fn included_filter_restricts_the_graph() {
        let bytes = fixture("ara3d/duplex.ifc");
        // Full model graph → pick two express ids → re-export isolated to them.
        let full: Value =
            serde_json::from_str(&export_jsonld(&bytes, &JsonLdOptions::default())).unwrap();
        let all = full["@graph"].as_array().unwrap();
        assert!(all.len() > 2, "fixture should have many entities");
        let pick: Vec<u32> = all
            .iter()
            .take(2)
            .map(|n| n["ifc:expressId"].as_u64().unwrap() as u32)
            .collect();

        let opts = JsonLdOptions { included: pick.clone(), ..Default::default() };
        let filtered: Value = serde_json::from_str(&export_jsonld(&bytes, &opts)).unwrap();
        let graph = filtered["@graph"].as_array().unwrap();
        assert_eq!(graph.len(), 2, "isolated export emits only the requested ids");
        for n in graph {
            let id = n["ifc:expressId"].as_u64().unwrap() as u32;
            assert!(pick.contains(&id), "unexpected entity {id} in filtered graph");
        }
    }
}
