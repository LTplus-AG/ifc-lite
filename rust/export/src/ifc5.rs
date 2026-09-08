// SPDX-License-Identifier: MPL-2.0
//! **IFC5 / IFCX** exporter — the USD-style node graph (`path` / `children` /
//! `attributes`) used by ifcx.dev. Ports the structural half of
//! `packages/export/src/ifc5-exporter.ts`: spatial hierarchy + `bsi::ifc::class` +
//! Name/Description + known IFC5 properties (`bsi::ifc::prop::*`). USD geometry
//! (`usd::usdgeom::mesh`) is the geometry follow-on, mirroring how glTF stays separate.

use std::collections::{HashMap, HashSet};

use ifc_lite_core::{DecodedEntity, EntityDecoder, EntityScanner};
use serde_json::{json, Map, Value};

use crate::json::typed_value;
use crate::model::{build_export_model, EntityRow};

/// IFC5 schema-package import URIs (ifcx.dev v5a).
/// The value every IFCX writer in this repo puts in `header.ifcxVersion`.
///
/// The TypeScript side owns the same constant (`IFCX_VERSION`, exported from
/// `@ifc-lite/data` and re-exported by `@ifc-lite/ifcx`). The two are pinned
/// together by the exportIfcx assertion in `scripts/test-wasm-contract.mjs`,
/// which reads the header back out of a file this exporter produced — readers
/// only match the substring `ifcx`, so nothing else would notice a drift.
const IFCX_VERSION: &str = "ifcx_alpha";

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
/// Fallback only — used when the entity has no `GlobalId` to carry forward
/// (e.g. the `IfcProject` root, decoded separately from the product rows
/// `path_for_id` below reads from).
fn uuid_from_id(id: u32) -> String {
    let a = (id as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ 0xABCD_EF01_2345_6789;
    let b = (id as u64).wrapping_mul(0xC2B2_AE3D_27D4_EB4F) ^ 0x0F1E_2D3C_4B5A_6978;
    let s = format!("{a:016x}{b:016x}");
    format!("{}-{}-{}-{}-{}", &s[0..8], &s[8..12], &s[12..16], &s[16..20], &s[20..32])
}

/// IFCX node path for an express id: the entity's own `GlobalId` when it has
/// one, so a BCF topic / diff / external reference keyed on the source
/// model's GlobalId still resolves to the same element after IFC→IFCX
/// conversion; the deterministic fallback otherwise. Mirrors the TS
/// exporter's `buildEntityMaps` (`packages/export/src/ifc5-exporter.ts`),
/// which already prefers GlobalId — the Rust port had dropped that and
/// unconditionally minted a fresh identity for every product, discarding the
/// original on every `ifc-lite export --format ifcx`.
fn path_for_id(id: u32, by_id: &HashMap<u32, &EntityRow>) -> String {
    if let Some(row) = by_id.get(&id) {
        if let Some(g) = &row.global_id {
            if !g.is_empty() {
                return g.clone();
            }
        }
    }
    uuid_from_id(id)
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

/// Spatial parent→children edges plus the first `IfcProject`.
///
/// A shim over [`crate::relationships`], which resolves these in the same pass
/// as the type edges. Kept because the three in-crate callers want only this
/// pair. Shared with the CSV and USD spatial exports.
pub(crate) fn spatial_children(content: &[u8]) -> (HashMap<u32, Vec<u32>>, Option<u32>) {
    let r = crate::relationships::relationships(content);
    (r.spatial_children, r.project)
}

/// Decode exactly one entity, found by scanning for its id.
///
/// The alternative is `build_entity_index` plus `decode_by_id`, which builds a
/// map of every entity in the file to answer one question: a full serial scan
/// and a multi-million-entry allocation on a large model. This walks until it
/// finds the id and stops, so a project node near the top of `DATA` costs almost
/// nothing. Worth it only for a handful of lookups, which is what the callers do.
pub(crate) fn decode_one(content: &[u8], id: u32) -> Option<DecodedEntity> {
    let mut decoder = EntityDecoder::new(content);
    let mut scanner = EntityScanner::new(content);
    while let Some((entity_id, _type_name, start, end)) = scanner.next_entity() {
        if entity_id == id {
            return decoder.decode_at(start, end).ok();
        }
    }
    None
}

/// Decode the IfcProject node (id, name) — it is not an IfcProduct so the export
/// model doesn't carry it. Shared with the USD exporter (`crate::usd`).
pub(crate) fn project_name(content: &[u8], project_id: u32) -> String {
    decode_one(content, project_id)
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
        node.insert("path".into(), json!(path_for_id(*id, &by_id)));

        if let Some(ch) = children.get(id) {
            let mut child_map = Map::new();
            for &c in ch {
                if !seen.contains(&c) {
                    continue;
                }
                let (cname, ctype) = name_of.get(&c).cloned().unwrap_or_default();
                child_map.insert(prim_name(&cname, &ctype, c), json!(path_for_id(c, &by_id)));
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
            // `ifcxVersion`, not `version`. That is the key buildingSMART's own
            // reference files carry, and the one `@ifc-lite/ifcx` requires to
            // recognise a file at all — so under the old name every file this
            // exporter produced was rejected by our own parser with
            // "Invalid IFCX file: missing or invalid header.ifcxVersion".
            "ifcxVersion": IFCX_VERSION,
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
#[path = "ifc5_tests.rs"]
mod tests;
