// SPDX-License-Identifier: MPL-2.0
//! **IFC5 / IFCX** exporter — the USD-style node graph (`path` / `children` /
//! `attributes`) used by ifcx.dev. Ports the structural half of
//! `packages/export/src/ifc5-exporter.ts`: spatial hierarchy + `bsi::ifc::class` +
//! Name/Description + known IFC5 properties (`bsi::ifc::prop::*`). USD geometry
//! (`usd::usdgeom::mesh`) is the geometry follow-on, mirroring how glTF stays separate.

use std::collections::{HashMap, HashSet};

use ifc_lite_core::{build_entity_index, EntityDecoder, EntityScanner};
use serde_json::{json, Map, Value};

use crate::json::typed_value;
use crate::model::{build_export_model, EntityRow};

/// IFC5 schema-package import URIs (ifcx.dev v5a).
const IMPORT_CORE: &str = "https://ifcx.dev/@standards.buildingsmart.org/ifc/core/ifc@v5a.ifcx";
const IMPORT_PROP: &str = "https://ifcx.dev/@standards.buildingsmart.org/ifc/core/prop@v5a.ifcx";

/// Property names with official IFC5 schema definitions (prop@v5a.ifcx). IFC4 props
/// outside this set are dropped — the viewer flags "Missing schema" otherwise.
const KNOWN_PROPS: &[&str] = &[
    "UsageType", "TypeName", "IsExternal", "RefElevation", "ElevationOfRefHeight",
    "ElevationOfTerrain", "NumberOfStoreys", "Height", "Width", "Length", "Depth",
    "Volume", "NetVolume", "NetArea", "NetSideArea", "CrossSectionArea", "Station",
];

/// Options for IFC5/IFCX export.
pub struct Ifc5Options {
    pub author: String,
    pub data_version: String,
    /// Keep only properties with a known IFC5 schema (default true).
    pub only_known_properties: bool,
    pub pretty: bool,
}

impl Default for Ifc5Options {
    fn default() -> Self {
        Self {
            author: "ifc-lite".to_string(),
            data_version: "1.0.0".to_string(),
            only_known_properties: true,
            pretty: false,
        }
    }
}

/// Deterministic UUID-shaped path for an express id (no RNG/clock — wasm-safe).
fn uuid_from_id(id: u32) -> String {
    let a = (id as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ 0xABCD_EF01_2345_6789;
    let b = (id as u64).wrapping_mul(0xC2B2_AE3D_27D4_EB4F) ^ 0x0F1E_2D3C_4B5A_6978;
    let s = format!("{a:016x}{b:016x}");
    format!("{}-{}-{}-{}-{}", &s[0..8], &s[8..12], &s[12..16], &s[16..20], &s[20..32])
}

/// Sanitize a USD prim name (the keys in a node's `children` dict).
fn prim_name(name: &str, fallback_type: &str, id: u32) -> String {
    let base = if name.trim().is_empty() { fallback_type } else { name };
    let mut out: String = base
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' { c } else { '_' })
        .collect();
    if out.is_empty() || !out.chars().next().unwrap().is_ascii_alphabetic() {
        out = format!("p_{out}");
    }
    // Append the id so siblings with identical names stay unique.
    format!("{out}_{id}")
}

/// Spatial parent→children edges from IfcRelAggregates + IfcRelContainedInSpatialStructure.
/// Returns the edge map and the first `IfcProject` id. Shared with the CSV spatial export.
pub(crate) fn spatial_children(content: &[u8]) -> (HashMap<u32, Vec<u32>>, Option<u32>) {
    let index = build_entity_index(content);
    let mut decoder = EntityDecoder::with_index(content, index);
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    let mut project: Option<u32> = None;

    let mut scanner = EntityScanner::new(content);
    while let Some((id, type_name, start, end)) = scanner.next_entity() {
        match type_name {
            "IFCPROJECT" => project = project.or(Some(id)),
            // IfcRelAggregates: RelatingObject(4), RelatedObjects(5, list)
            "IFCRELAGGREGATES" => {
                if let Ok(rel) = decoder.decode_at_with_id(id, start, end) {
                    if let Some(parent) = rel.get(4).and_then(|a| a.as_entity_ref()) {
                        if let Some(list) = rel.get(5).and_then(|a| a.as_list()) {
                            for c in list {
                                if let Some(cid) = c.as_entity_ref() {
                                    children.entry(parent).or_default().push(cid);
                                }
                            }
                        }
                    }
                }
            }
            // IfcRelContainedInSpatialStructure: RelatedElements(4, list), RelatingStructure(5)
            "IFCRELCONTAINEDINSPATIALSTRUCTURE" => {
                if let Ok(rel) = decoder.decode_at_with_id(id, start, end) {
                    if let Some(parent) = rel.get(5).and_then(|a| a.as_entity_ref()) {
                        if let Some(list) = rel.get(4).and_then(|a| a.as_list()) {
                            for c in list {
                                if let Some(cid) = c.as_entity_ref() {
                                    children.entry(parent).or_default().push(cid);
                                }
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }
    (children, project)
}

/// Decode the IfcProject node (id, name) — it is not an IfcProduct so the export
/// model doesn't carry it.
fn project_name(content: &[u8], project_id: u32) -> String {
    let index = build_entity_index(content);
    let mut decoder = EntityDecoder::with_index(content, index);
    decoder
        .decode_by_id(project_id)
        .ok()
        .and_then(|e| e.get(2).and_then(|a| a.as_string()).map(|s| s.to_string()))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Project".to_string())
}

fn build_node_attributes(row: Option<&EntityRow>, ifc_type: &str, opts: &Ifc5Options) -> Map<String, Value> {
    let mut attrs = Map::new();
    attrs.insert("bsi::ifc::class".into(), json!({ "code": ifc_type }));
    if let Some(r) = row {
        if let Some(n) = &r.name {
            attrs.insert("bsi::ifc::prop::Name".into(), json!(n));
        }
        if let Some(d) = &r.description {
            attrs.insert("bsi::ifc::prop::Description".into(), json!(d));
        }
        for ps in &r.property_sets {
            for p in &ps.properties {
                if opts.only_known_properties && !KNOWN_PROPS.contains(&p.name.as_str()) {
                    continue;
                }
                attrs.insert(format!("bsi::ifc::prop::{}", p.name), typed_value(p));
            }
        }
    }
    attrs
}

/// Export the model in `content` as an IFCX (IFC5) document string.
pub fn export_ifc5(content: &[u8], opts: &Ifc5Options) -> String {
    let model = build_export_model(content);
    let by_id: HashMap<u32, &EntityRow> = model.entities.iter().map(|e| (e.express_id, e)).collect();
    let (children, project) = spatial_children(content);

    // Names/types for prim-name + class. Products come from the model; the project
    // is decoded separately.
    let mut name_of: HashMap<u32, (String, String)> = HashMap::new(); // id -> (name, type)
    for e in &model.entities {
        name_of.insert(e.express_id, (e.name.clone().unwrap_or_default(), e.ifc_type.clone()));
    }

    // Determine which nodes to emit: the project + everything reachable through
    // the spatial children edges (so orphan rels/types don't leak in).
    let mut emit: Vec<u32> = Vec::new();
    let mut seen: HashSet<u32> = HashSet::new();
    if let Some(pid) = project {
        name_of
            .entry(pid)
            .or_insert_with(|| (project_name(content, pid), "IfcProject".to_string()));
        let mut stack = vec![pid];
        while let Some(id) = stack.pop() {
            if !seen.insert(id) {
                continue;
            }
            emit.push(id);
            if let Some(ch) = children.get(&id) {
                for &c in ch {
                    if !seen.contains(&c) {
                        stack.push(c);
                    }
                }
            }
        }
    } else {
        // No project — emit every product as a flat list.
        for e in &model.entities {
            emit.push(e.express_id);
        }
    }

    let mut data: Vec<Value> = Vec::with_capacity(emit.len());
    for id in &emit {
        let (_name, ifc_type) = name_of
            .get(id)
            .cloned()
            .unwrap_or_else(|| (String::new(), "IfcProduct".to_string()));
        let mut node = Map::new();
        node.insert("path".into(), json!(uuid_from_id(*id)));

        if let Some(ch) = children.get(id) {
            let mut child_map = Map::new();
            for &c in ch {
                if !seen.contains(&c) {
                    continue;
                }
                let (cname, ctype) = name_of.get(&c).cloned().unwrap_or_default();
                child_map.insert(prim_name(&cname, &ctype, c), json!(uuid_from_id(c)));
            }
            if !child_map.is_empty() {
                node.insert("children".into(), Value::Object(child_map));
            }
        }

        let attrs = build_node_attributes(by_id.get(id).copied(), &ifc_type, opts);
        if !attrs.is_empty() {
            node.insert("attributes".into(), Value::Object(attrs));
        }
        data.push(Value::Object(node));
    }

    let doc = json!({
        "header": {
            "version": "ifcx_alpha",
            "author": opts.author,
            "dataVersion": opts.data_version,
        },
        "imports": [ { "uri": IMPORT_CORE }, { "uri": IMPORT_PROP } ],
        "schemas": {},
        "data": data,
    });

    if opts.pretty {
        serde_json::to_string_pretty(&doc).expect("ifcx serializes")
    } else {
        serde_json::to_string(&doc).expect("ifcx serializes")
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
    fn duplex_exports_valid_ifcx() {
        let s = export_ifc5(&fixture("ara3d/duplex.ifc"), &Ifc5Options::default());
        let v: Value = serde_json::from_str(&s).expect("valid JSON");
        assert_eq!(v["header"]["version"], "ifcx_alpha");
        assert_eq!(v["imports"][0]["uri"], IMPORT_CORE);

        let data = v["data"].as_array().expect("data array");
        assert!(data.len() > 20, "expected a populated node graph, got {}", data.len());

        // Every node has a UUID path; classes are bsi::ifc::*.
        let paths: HashSet<&str> = data.iter().filter_map(|n| n["path"].as_str()).collect();
        assert_eq!(paths.len(), data.len(), "paths are unique");
        for n in data {
            assert!(n["path"].as_str().unwrap().contains('-'), "uuid-shaped path");
        }

        // A project root exists and its class is IfcProject.
        let has_project = data
            .iter()
            .any(|n| n["attributes"]["bsi::ifc::class"]["code"] == "IfcProject");
        assert!(has_project, "project node present");

        // Children dict values reference real node paths (no dangling spatial edges).
        for n in data {
            if let Some(ch) = n["children"].as_object() {
                for (_k, cpath) in ch {
                    assert!(paths.contains(cpath.as_str().unwrap()), "child path resolves");
                }
            }
        }

        // At least one node carries a known IFC5 property in the bsi::ifc::prop:: namespace.
        let has_prop = data.iter().any(|n| {
            n["attributes"].as_object().is_some_and(|a| {
                a.keys().any(|k| k.starts_with("bsi::ifc::prop::") && k != "bsi::ifc::prop::Name")
            })
        });
        assert!(has_prop, "expected a typed IFC5 property somewhere");
    }

    #[test]
    fn unknown_props_filtered_by_default() {
        let s = export_ifc5(&fixture("ara3d/duplex.ifc"), &Ifc5Options::default());
        // 'LoadBearing' / 'Reference' are IFC4 props NOT in the IFC5 known set.
        assert!(!s.contains("bsi::ifc::prop::LoadBearing"));
        assert!(!s.contains("bsi::ifc::prop::Reference\""));
    }
}
