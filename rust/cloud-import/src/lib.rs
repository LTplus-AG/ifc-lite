/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
mod meshes;
use nalgebra::Matrix4;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};

pub type Result<T> = std::result::Result<T, String>;
const MAX_OCCURRENCES: usize = 100_000;
const MAX_DEPTH: usize = 256;
const MAX_POINTS: usize = 10_000_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub revision_id: String,
    pub elements: BTreeMap<String, Element>,
    pub site: Value,
}
#[derive(Deserialize)]
pub struct Element {
    pub urn: String,
    #[serde(default)]
    pub properties: Value,
    #[serde(default)]
    pub metadata: Value,
    #[serde(default)]
    pub representations: BTreeMap<String, Value>,
    #[serde(default)]
    pub children: Vec<Child>,
}
#[derive(Deserialize)]
pub struct Child {
    pub key: String,
    pub urn: String,
    pub transform: Option<[f64; 16]>,
}

pub fn matrix(values: Option<[f64; 16]>) -> Result<Matrix4<f64>> {
    let m = values.map(|v| Matrix4::from_column_slice(&v)).unwrap_or_else(Matrix4::identity);
    if !m.iter().all(|v| v.is_finite()) || m[(3, 0)] != 0.0 || m[(3, 1)] != 0.0
        || m[(3, 2)] != 0.0 || m[(3, 3)] != 1.0 || m.fixed_view::<3, 3>(0, 0).determinant().abs() < 1e-12 {
        return Err("Invalid or singular affine transform".into());
    }
    Ok(m)
}

/// Immutable URNs cache source data; occurrence paths preserve repeated instances.
/// Iterative traversal bounds stack, path-scoped cycles AND acyclic DAG fan-out.
pub fn convert(snapshot: &Snapshot, blobs: &BTreeMap<String, Vec<u8>>) -> Result<Value> {
    let mut stack = vec![(snapshot.revision_id.clone(), "forma".to_string(), Matrix4::identity(), HashSet::new())];
    let mut data = Vec::new();
    let mut point_count = 0;
    let mut mesh_count = 0;
    while let Some((urn, path, transform, mut ancestors)) = stack.pop() {
        if data.len() >= MAX_OCCURRENCES || ancestors.len() >= MAX_DEPTH {
            return Err("Forma hierarchy exceeds the occurrence/depth limit".into());
        }
        if !ancestors.insert(urn.clone()) { return Err("Cycle in Forma element hierarchy".into()); }
        let element = snapshot.elements.get(&urn).ok_or("Missing referenced Forma element")?;
        if element.urn != urn { return Err("Forma element revision mismatch".into()); }
        let mut attrs = json!({
            "bsi::ifc::class": {"code":"IfcBuildingElementProxy", "uri":"https://identifier.buildingsmart.org/uri/buildingsmart/ifc/5/class/IfcBuildingElementProxy"},
            "bsi::ifc::prop::Name": element.properties.get("name").and_then(Value::as_str).unwrap_or(&urn),
            "autodesk::SourceUrn": urn,
            "autodesk::Properties": element.properties,
            "autodesk::Metadata": element.metadata,
            "autodesk::Representations": element.representations,
        });
        if path == "forma" {
            attrs["autodesk::Site"] = snapshot.site.clone();
            attrs["bsi::ifc::class"] = json!({"code":"IfcSite","uri":"https://identifier.buildingsmart.org/uri/buildingsmart/ifc/5/class/IfcSite"});
            if let Some(system) = snapshot.site.get("coordinateSystem") {
                let srid = system["srid"].as_str().map(str::to_string).or_else(|| system["srid"].as_u64().map(|v| v.to_string()));
                let point = system["refPoint"].as_array();
                if let (Some(srid), Some(point)) = (srid, point) {
                    if point.len() >= 2 {
                        if let (Some(east), Some(north)) = (point[0].as_f64(), point[1].as_f64()) {
                            let name = if srid.starts_with("EPSG:") { srid } else { format!("EPSG:{srid}") };
                            attrs["ifclite::georeference::v1"] = json!({
                                "IfcProjectedCRS":{"Name":name,"MapUnit":"METRE"},
                                "IfcMapConversion":{"Eastings":east,"Northings":north,"OrthogonalHeight":0,"XAxisAbscissa":1,"XAxisOrdinate":0,"Scale":1}
                            });
                        }
                    }
                }
            }
        }
        let mut children = BTreeMap::new();
        let mut keys = HashSet::new();
        for child in &element.children {
            if stack.len() + data.len() >= MAX_OCCURRENCES {
                return Err("Forma hierarchy exceeds the queued occurrence limit".into());
            }
            if !keys.insert(&child.key) { return Err("Invalid/duplicate Forma child key".into()); }
            // Hex UTF-8 avoids delimiter collisions while keeping stable occurrence identities.
            let key: String = child.key.as_bytes().iter().map(|b| format!("{b:02x}")).collect();
            let key = format!("key-{key}");
            let child_path = format!("{path}/{key}");
            children.insert(key, child_path.clone());
            stack.push((child.urn.clone(), child_path, transform * matrix(child.transform)?, ancestors.clone()));
        }
        let mut node = json!({"path":path, "attributes":attrs, "children":children});
        if !element.representations.contains_key("volumeMesh")
            && (element.representations.contains_key("volume25DCollection") || element.representations.contains_key("graphBuilding")) {
            return Err("Physical Forma representation has no supported volume mesh".into());
        }
        if let Some(rep) = element.representations.get("volumeMesh") {
            if rep["type"] != "linked" { return Err("Unsupported Forma volumeMesh representation".into()); }
            let blob_id = rep["blobId"].as_str().ok_or("Missing Forma mesh blob")?;
            let context = element.urn.split(':').nth(3).unwrap_or("");
            let bytes = blobs.get(&format!("{context}:{blob_id}")).ok_or("Missing Forma mesh data")?;
            let geometry = meshes::extract(bytes, rep, &transform, &mut point_count)?;
            if geometry.is_empty() { return Err("Forma mesh selection produced no geometry".into()); }
            for (index, mesh) in geometry.into_iter().enumerate() {
                let mesh_path = format!("{path}/mesh-{index}");
                node["children"][format!("mesh-{index}")] = json!(mesh_path);
                data.push(json!({"path":mesh_path,"attributes":mesh}));
                mesh_count += 1;
            }
        }
        data.push(node);
    }
    if mesh_count == 0 { return Err("Proposal contains no supported volume meshes".into()); }
    Ok(json!({
        "header":{"id":snapshot.revision_id,"ifcxVersion":"ifcx_alpha","dataVersion":snapshot.revision_id,"author":"Autodesk Forma","timestamp":snapshot.elements.get(&snapshot.revision_id).and_then(|e| e.metadata.get("createdAt")).and_then(Value::as_str).unwrap_or("1970-01-01T00:00:00Z")},
        "imports":[
            {"uri":"https://ifcx.dev/@standards.buildingsmart.org/ifc/core/ifc@v5a.ifcx"},
            {"uri":"https://ifcx.dev/@standards.buildingsmart.org/ifc/core/prop@v5a.ifcx"},
            {"uri":"https://ifcx.dev/@openusd.org/usd@v1.ifcx"}
        ],"schemas":{},"data":data
    }))
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;
