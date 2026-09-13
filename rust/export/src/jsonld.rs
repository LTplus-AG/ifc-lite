// SPDX-License-Identifier: MPL-2.0
//! **JSON-LD** exporter for semantic-web interop. Ports
//! `packages/export/src/jsonld-exporter.ts`: an `@graph` of `ifc:`-prefixed nodes
//! with `hasPropertySets` / `hasQuantitySets`, against the buildingSMART IFC4 OWL vocab.

use serde_json::{json, Value};

use crate::json::{finite_json_number, typed_value};
use crate::model::build_export_model;

const DEFAULT_CONTEXT: &str = "https://standards.buildingsmart.org/IFC/DEV/IFC4/ADD2/OWL";

/// Options for JSON-LD export.
pub struct JsonLdOptions {
    /// Ontology context IRI (default buildingSMART IFC4 ADD2 OWL).
    pub context: String,
    pub include_properties: bool,
    pub include_quantities: bool,
    pub pretty: bool,
    /// Express-id isolation filter. Empty preserves the historical public API
    /// contract and means all entities; callers that must distinguish an
    /// active empty filter use [`export_jsonld_with_filter`].
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
    let included = (!opts.included.is_empty()).then_some(opts.included.as_slice());
    export_jsonld_with_filter(content, opts, included)
}

/// Export JSON-LD with an explicit null-vs-empty isolation filter.
///
/// `None` means no filter, `Some(ids)` means an active allowlist, and
/// `Some(empty)` emits an empty `@graph`. This additive entry point lets wasm
/// preserve that distinction without changing [`JsonLdOptions`]' stable public
/// field shape (#4659).
pub fn export_jsonld_with_filter(
    content: &[u8],
    opts: &JsonLdOptions,
    included: Option<&[u32]>,
) -> String {
    let model = build_export_model(content);
    let filter: Option<std::collections::HashSet<u32>> =
        included.map(|ids| ids.iter().copied().collect());
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
                                "ifc:value": finite_json_number(q.value),
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

    #[test]
    fn duplex_exports_valid_jsonld() {
        let s = export_jsonld(&fixture_or_skip!("ara3d/duplex.ifc"), &JsonLdOptions::default());
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
    /// #4659: `Some(empty)` means "the isolation filter is active and matched
    /// nothing", not "no filter". The wasm binding previously collapsed its
    /// empty array into the legacy `JsonLdOptions::included` meaning of
    /// "export everything", so a zero-match `--type` handed the user the whole
    /// model. The explicit helper preserves both contracts without breaking
    /// existing Rust callers.
    ///
    /// The `None` sibling pins the other direction: the two must not collapse
    /// into each other in either direction.
    #[test]
    fn an_active_but_empty_included_set_emits_an_empty_graph() {
        let ifc = "ISO-10303-21;\n\
HEADER;\n\
FILE_DESCRIPTION((''),'');\n\
FILE_NAME('','',(''),(''),'','','');\n\
FILE_SCHEMA(('IFC4'));\n\
ENDSEC;\n\
DATA;\n\
#4=IFCPROJECT('0PROJECT0000000000000',$,'P',$,$,$,$,$,$);\n\
#5=IFCWALL('0WALL000000000000000A',$,'W1',$,$,$,$,$,$);\n\
#6=IFCWALL('0WALL000000000000000B',$,'W2',$,$,$,$,$,$);\n\
#7=IFCSLAB('0SLAB000000000000000A',$,'S1',$,$,$,$,$,$);\n\
ENDSEC;\n\
END-ISO-10303-21;\n";
        // No filter: every entity. Asserted first so the empty-graph assertion
        // below cannot pass merely because the fixture exports nothing.
        let opts = JsonLdOptions::default();
        let unfiltered: Value = serde_json::from_str(&export_jsonld_with_filter(
            ifc.as_bytes(),
            &opts,
            None,
        ))
        .unwrap();
        let unfiltered = unfiltered["@graph"].as_array().expect("graph array").len();
        assert_eq!(unfiltered, 3, "unfiltered graph carries every entity in the fixture");

        // A filter that matches something still narrows.
        let narrowed: Value = serde_json::from_str(&export_jsonld_with_filter(
            ifc.as_bytes(),
            &opts,
            Some(&[5, 6]),
        ))
        .unwrap();
        let narrowed = narrowed["@graph"].as_array().expect("graph array").len();
        assert_eq!(narrowed, 2, "an explicit two-entity filter emits exactly those entities");

        // A filter that matches nothing emits nothing.
        let zero_match: Value = serde_json::from_str(&export_jsonld_with_filter(
            ifc.as_bytes(),
            &opts,
            Some(&[]),
        ))
        .unwrap();
        let zero_match = zero_match["@graph"].as_array().expect("graph array").len();
        assert_eq!(zero_match, 0, "an active-but-empty filter must not export the whole model");
    }

    #[test]
    fn included_filter_restricts_the_graph() {
        let bytes = fixture_or_skip!("ara3d/duplex.ifc");
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

    /// Mirrors `json::tests::a_non_finite_quantity_survives_instead_of_becoming_null`:
    /// an out-of-range `REAL` (parses to `f64::INFINITY`) must not collapse the
    /// `ifc:value` to JSON `null`, which reads as "quantity absent".
    #[test]
    fn a_non_finite_quantity_survives_instead_of_becoming_null() {
        let ifc = "ISO-10303-21;\n\
HEADER;\n\
FILE_DESCRIPTION((''),'');\n\
FILE_NAME('','',(''),(''),'','','');\n\
FILE_SCHEMA(('IFC4'));\n\
ENDSEC;\n\
DATA;\n\
#1=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);\n\
#3=IFCUNITASSIGNMENT((#1));\n\
#4=IFCPROJECT('0PROJECT0000000000000',$,'P',$,$,$,$,$,#3);\n\
#5=IFCWALL('0WALL000000000000000A',$,'W',$,$,$,$,$,$);\n\
#20=IFCQUANTITYLENGTH('Length',$,$,1.0E400);\n\
#21=IFCELEMENTQUANTITY('0QTO00000000000000A',$,'Qto_WallBaseQuantities',$,$,(#20));\n\
#22=IFCRELDEFINESBYPROPERTIES('0REL000000000000000A',$,$,$,(#5),#21);\n\
ENDSEC;\n\
END-ISO-10303-21;\n";
        let opts = JsonLdOptions { include_quantities: true, ..Default::default() };
        let s = export_jsonld(ifc.as_bytes(), &opts);
        let v: Value = serde_json::from_str(&s).expect("valid JSON");
        let graph = v["@graph"].as_array().expect("graph array");
        let wall = graph.iter().find(|n| n["ifc:globalId"] == "0WALL000000000000000A").expect("wall node");
        let quants = wall["ifc:hasQuantitySets"][0]["ifc:quantities"].as_array().expect("quantities array");
        let length = quants.iter().find(|q| q["ifc:name"] == "Length").expect("Length quantity present");
        assert!(!length["ifc:value"].is_null(), "an out-of-range REAL must not collapse to null");
        assert_eq!(length["ifc:value"], json!("inf"));
    }
}
