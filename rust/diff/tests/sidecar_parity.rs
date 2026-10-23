// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use ifc_lite_diff::{sidecar::*, identity_map::IdentityMapEntry, lineage::{LineageEntry,LineageRelation}};
use serde_json::Value;
fn text(v: &Value, key: &str) -> String { v[key].as_str().unwrap().into() }
fn optional(v: &Value, key: &str) -> Option<String> { v[key].as_str().map(str::to_owned) }
fn model(v: &Value) -> ModelIdentity { ModelIdentity { hash: text(v,"hash"),path:optional(v,"path") } }
#[test]
fn sidecar_wire_is_byte_identical_to_typescript_issue_8042() {
    let vectors: Vec<Value> = serde_json::from_str(include_str!("sidecar_vectors.json")).unwrap();
    for vector in vectors {
        let v = &vector["value"];
        let models = SidecarModels { base:model(&v["base"]),head:model(&v["head"]),key_property:optional(v,"keyProperty") };
        let version = v["version"].as_u64().unwrap() as u32;
        let created = optional(v,"created");
        let wire = if vector["kind"] == "identity" {
            let entries = v["entries"].as_array().unwrap().iter().map(|e| IdentityMapEntry { base:text(e,"base"),here:text(e,"here"),reason:text(e,"reason") }).collect();
            serialize_identity_sidecar(&IdentitySidecar { models,version,created,entries })
        } else {
            let entries = v["entries"].as_array().unwrap().iter().map(|e| LineageEntry {
                base:serde_json::from_value(e["base"].clone()).unwrap(),head:serde_json::from_value(e["head"].clone()).unwrap(),
                relation:match e["relation"].as_str().unwrap() { "identity"=>LineageRelation::Identity,"split"=>LineageRelation::Split,"merge"=>LineageRelation::Merge,_=>LineageRelation::Replaced },
                reason:text(e,"reason"),shares:e.get("shares").map(|s| serde_json::from_value(s.clone()).unwrap()),
            }).collect();
            serialize_lineage_sidecar(&LineageSidecar { models,version,created,entries,deleted:serde_json::from_value(v["deleted"].clone()).unwrap() })
        };
        assert_eq!(wire, vector["wire"].as_str().unwrap());
    }
}
