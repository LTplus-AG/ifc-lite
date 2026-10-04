/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
use super::*;

// A real binary glTF triangle fixture, with a node translation and material.
fn triangle() -> Vec<u8> {
    let mut binary = Vec::new();
    for point in [[0.0_f32, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]] {
        for v in point { binary.extend_from_slice(&v.to_le_bytes()); }
    }
    let doc = json!({"asset":{"version":"2.0"},"scene":0,"scenes":[{"nodes":[0]}],
        "nodes":[{"mesh":0,"translation":[0,2,0]}],
        "meshes":[{"name":"part","primitives":[{"attributes":{"POSITION":0},"material":0}]}],
        "materials":[{"alphaMode":"BLEND","pbrMetallicRoughness":{"baseColorFactor":[1,0,0,0.5]}}],
        "buffers":[{"byteLength":36}],"bufferViews":[{"buffer":0,"byteLength":36}],
        "accessors":[{"bufferView":0,"componentType":5126,"count":3,"type":"VEC3","min":[0,0,0],"max":[1,1,0]}]});
    let mut json = serde_json::to_vec(&doc).unwrap();
    while !json.len().is_multiple_of(4) { json.push(b' '); }
    let length = (12 + 8 + json.len() + 8 + binary.len()) as u32;
    let mut bytes = Vec::new();
    for word in [0x46546c67_u32, 2, length, json.len() as u32, 0x4e4f534a] { bytes.extend_from_slice(&word.to_le_bytes()); }
    bytes.extend(json);
    for word in [binary.len() as u32, 0x004e4942] { bytes.extend_from_slice(&word.to_le_bytes()); }
    bytes.extend(binary);
    bytes
}
fn snapshot() -> Snapshot {
    serde_json::from_value(json!({"revisionId":"root","site":{"coordinateSystem":{"srid":"EPSG:32632","refPoint":[500000,6000000]}},"elements":{
        "root":{"urn":"root","children":[{"key":"a","urn":"part"},{"key":"b","urn":"part","transform":[1,0,0,0,0,1,0,0,0,0,1,0,10,0,0,1]}]},
        "part":{"urn":"part","properties":{"name":"Repeated floor","category":"building","analysisFigures":{"parking":{"numberOfParkingSpots":2}}},"representations":{"volumeMesh":{"type":"linked","blobId":"blob","selection":{"type":"equals","value":"part"}}}}
    }})).unwrap()
}
#[test]
fn repeated_instances_keep_coordinates_material_and_source_properties() {
    let snapshot = snapshot();
    let file = convert(&snapshot, &BTreeMap::from([(":blob".into(), triangle())])).unwrap();
    let data = file["data"].as_array().unwrap();
    let meshes: Vec<_> = data.iter().filter_map(|n| n["attributes"].get("usd::usdgeom::mesh")).collect();
    assert_eq!(meshes.len(), 2);
    let mut x: Vec<_> = meshes.iter().map(|m| m["points"][0][0].as_f64().unwrap()).collect();
    x.sort_by(f64::total_cmp);
    assert_eq!(x, vec![0.0, 10.0]);
    // glTF Y=2 maps to Forma Z=2 exactly once.
    assert!(meshes.iter().all(|m| m["points"][0] [2] == 2.0));
    assert!(data.iter().any(|n| n["attributes"]["autodesk::Properties"]["analysisFigures"]["parking"]["numberOfParkingSpots"] == 2));
    assert!(data.iter().any(|n| n["attributes"]["bsi::ifc::presentation::opacity"] == 0.5));
    assert_eq!(file["header"]["ifcxVersion"], "ifcx_alpha");
}
#[test]
fn cycles_and_missing_revisions_report_failure() {
    let mut snapshot = snapshot();
    snapshot.elements.get_mut("part").unwrap().children.push(Child { key:"back".into(), urn:"root".into(), transform:None });
    assert!(convert(&snapshot, &BTreeMap::from([(":blob".into(), triangle())])).unwrap_err().contains("Cycle"));
    snapshot.elements.remove("part");
    assert!(convert(&snapshot, &BTreeMap::new()).unwrap_err().contains("Missing"));
}
#[test]
fn selection_and_transform_fail_closed() {
    let mut snapshot = snapshot();
    snapshot.elements.get_mut("part").unwrap().representations.get_mut("volumeMesh").unwrap()["selection"]["value"] = json!("other");
    assert!(convert(&snapshot, &BTreeMap::from([(":blob".into(), triangle())])).unwrap_err().contains("no geometry"));
    assert!(matrix(Some([0.0;16])).is_err());
    let mut m: [f64;16] = std::array::from_fn(|i| if i % 5 == 0 { 1.0 } else { 0.0 }); m[0] = f64::NAN;
    assert!(matrix(Some(m)).is_err());
}
#[test]
fn long_acyclic_chains_are_bounded_without_recursion() {
    let mut snapshot = snapshot();
    for i in 0..300 { snapshot.elements.insert(format!("chain{i}"), Element { urn:format!("chain{i}"), properties:Value::Null, metadata:Value::Null, representations:BTreeMap::new(), children:vec![Child{key:"next".into(), urn:format!("chain{}",i+1),transform:None}] }); }
    snapshot.revision_id = "chain0".into();
    assert!(convert(&snapshot, &BTreeMap::new()).unwrap_err().contains("limit"));
}
#[test]
fn wide_repeated_instances_are_bounded_before_the_queue_expands() {
    let mut snapshot = snapshot();
    snapshot.elements.get_mut("root").unwrap().children = (0..=MAX_OCCURRENCES)
        .map(|i| Child { key: i.to_string(), urn: "part".into(), transform: None }).collect();
    assert!(convert(&snapshot, &BTreeMap::new()).unwrap_err().contains("queued occurrence limit"));
}
