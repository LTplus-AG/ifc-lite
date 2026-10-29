// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
use ifc_lite_diff::{engine::diff_models, model::*, transport_options::options_from_json,
    transport_result::result_to_document};
use serde_json::json;

fn entity(key: &str, hash: &str, data: &str, reference: usize) -> EntityFingerprint<usize> {
    EntityFingerprint { key: key.into(), ifc_type: "IfcWall".into(), data_hash: data.into(),
        geometry_hash: Some(hash.into()), aabb: Some(EntityAabb { min: [0.0; 3], max: [1.0; 3] }),
        volume: Some(1.0), components: None, container: Some("Storey".into()), reference }
}

// #8042 A1: filtering is a per-compare view of the resident model. Key and
// content passes must see exactly the same hashes as explicit JS stripping.
#[test]
fn placement_option_equals_explicit_stripping_without_mutating_models_8042() {
    let base = vec![entity("same", "p:before", "d", 0), entity("old", "p:old", "d", 1),
        entity("mesh", "42", "m", 2), entity("same", "unused-duplicate", "d", 3),
        entity("case-sensitive", "P:mesh", "d", 4)];
    let head = vec![entity("same", "p:after", "d", 0), entity("new", "p:new", "d", 1),
        entity("mesh", "43", "m", 2), entity("case-sensitive", "p:placement", "d", 3)];
    let strip = |rows: &[EntityFingerprint<usize>]| rows.iter().cloned().map(|mut row| {
        if row.geometry_hash.as_ref().is_some_and(|h| h.units().starts_with(&[112, 58])) {
            row.geometry_hash = None;
        }
        row
    }).collect::<Vec<_>>();
    let projected_base = strip(&base);
    let projected_head = strip(&head);
    let before = result_to_document(&diff_models(&base, &head, &Default::default()));
    for scope in ["both", "geometry", "data"] {
        for exclude in [json!([]), json!(["IfcWall"])] {
            for aliases in [json!([]), json!([["new", "old"]])] {
                let mut options = options_from_json(&json!({"scope": scope, "excludeTypes": exclude,
                    "keyAliases": aliases, "matchUnpairedByContent": true,
                    "detectSplitMerge": true, "detectSuccessors": true}));
                let expected = result_to_document(&diff_models(&projected_base, &projected_head, &options));
                options.key.strip_placement_geometry = true;
                let actual = result_to_document(&diff_models(&base, &head, &options));
                assert_eq!(actual, expected);
            }
        }
    }
    assert_eq!(result_to_document(&diff_models(&base, &head, &Default::default())), before);
    assert_eq!(base[0].geometry_hash.as_ref().and_then(ifc_lite_diff::JsString::as_str), Some("p:before"));
}
