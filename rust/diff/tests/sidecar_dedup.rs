// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use ifc_lite_diff::sidecar_document::{create_sidecar_document, parse_ordered_json, SidecarKind};
use ifc_lite_diff::DocumentValue;

#[test]
fn issue_8088_dedup_preserves_claim_boundaries_and_exposes_conflicts() {
    let vectors = parse_ordered_json(include_str!("sidecar_dedup_vectors.json")).unwrap();
    for vector in vectors.as_array().unwrap() {
        let kind = if vector["kind"].as_str() == Some("identity") { SidecarKind::Identity } else { SidecarKind::Lineage };
        let result = create_sidecar_document(&vector["init"], kind, |_| false);
        if let Some(error) = vector["error"].as_str() {
            assert!(result.unwrap_err().to_string().contains(error), "{:?}", vector["name"]);
        } else {
            let expected = vector["order"].as_array().unwrap().iter().map(|index| {
                vector["init"]["entries"][index.as_f64().unwrap() as usize].clone()
            }).collect();
            assert_eq!(result.unwrap()["entries"], DocumentValue::Array(expected), "{:?}", vector["name"]);
        }
    }
}
