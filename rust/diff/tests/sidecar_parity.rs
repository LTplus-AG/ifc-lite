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

#[test]
fn sidecar_validation_matches_typescript_issue_8042() {
    use ifc_lite_diff::sidecar_validation::*;
    let vectors: Vec<Value> = serde_json::from_str(include_str!("sidecar_validation_vectors.json")).unwrap();
    for vector in vectors {
        // Corpus date strings are empty, x or FEFF: all invalid in Date.parse.
        // Host parsing itself is deliberately tested separately below.
        let errors = if vector["kind"] == "identity" { validate_identity_sidecar(&vector["value"], |_| false) }
            else { validate_lineage_sidecar(&vector["value"], |_| false) };
        assert_eq!(serde_json::json!(errors), vector["errors"], "{} {}",vector["kind"],vector["name"]);
    }
}
#[test]
fn timestamp_semantics_are_supplied_by_the_host_issue_8042() {
    use ifc_lite_diff::sidecar_validation::validate_identity_sidecar;
    let value = serde_json::json!({"format":"ifc-lite/identity-map","version":1,"base":{"hash":"a"},"head":{"hash":"b"},"entries":[],"created":"2000"});
    assert!(validate_identity_sidecar(&value, |s| s == "2000").is_empty());
    assert_eq!(validate_identity_sidecar(&value, |_| false), ["created must be an ISO 8601 timestamp when present"]);
}

#[test]
fn sidecar_create_and_parse_keep_canonical_bytes_issue_8042() {
    use ifc_lite_diff::sidecar_document::*;
    let vectors: Vec<Value> = serde_json::from_str(include_str!("sidecar_vectors.json")).unwrap();
    for vector in vectors {
        let kind = if vector["kind"] == "identity" { SidecarKind::Identity } else { SidecarKind::Lineage };
        let mut init = vector["value"].clone();
        let entries = init["entries"].as_array_mut().unwrap();
        entries.reverse();
        if let Some(first) = entries.first().cloned() {
            let mut duplicate = first;
            duplicate["reason"] = Value::String("must not replace the first reason".into());
            entries.push(duplicate);
        }
        if let Some(deleted) = init.get_mut("deleted").and_then(Value::as_array_mut) {
            deleted.reverse();
            deleted.extend(deleted.clone());
        }
        init["base"]["extra"] = Value::Bool(true);
        let created = create_sidecar(&init,kind,|s|s=="2026-10-23T06:00:00.000Z").unwrap();
        let wire = serialize_sidecar(&created);
        assert_eq!(wire,vector["wire"].as_str().unwrap());
        let parsed = parse_sidecar(&wire,kind,|s|s=="2026-10-23T06:00:00.000Z").unwrap();
        assert_eq!(serialize_sidecar(&parsed),wire);
    }
}
#[test]
fn sidecar_parse_preserves_extras_and_js_integer_key_order_issue_8042() {
    use ifc_lite_diff::sidecar_document::*;
    let text = r#"{"format":"ifc-lite/identity-map","version":1,"base":{"hash":"a"},"head":{"hash":"b"},"entries":[],"extra":{"20":"x","2":"y","01":"z"}}"#;
    let value = parse_sidecar(text,SidecarKind::Identity,|_|false).unwrap();
    let wire = serialize_sidecar(&value);
    assert!(wire.contains("\"extra\": {\n    \"2\": \"y\",\n    \"20\": \"x\",\n    \"01\": \"z\"\n  }"));
    assert!(parse_sidecar("{",SidecarKind::Identity,|_|false).unwrap_err().starts_with("Invalid identity-map sidecar: not JSON ("));
}
