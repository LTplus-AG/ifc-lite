// SPDX-License-Identifier: MPL-2.0
//! Tests for [`super::ifc5`]. Split out of `ifc5.rs` to keep that module
//! under the 400-line rule (AGENTS.md), matching the `schema_convert.rs` /
//! `schema_convert_tests.rs` pattern.

use super::*;

#[test]
fn duplex_exports_valid_ifcx() {
    let s = export_ifc5(&fixture_or_skip!("ara3d/duplex.ifc"), &Ifc5Options::default());
    let v: Value = serde_json::from_str(&s).expect("valid JSON");
    assert_eq!(v["header"]["ifcxVersion"], IFCX_VERSION);
    assert_eq!(v["imports"][0]["uri"], IMPORT_CORE);

    let data = v["data"].as_array().expect("data array");
    assert!(data.len() > 20, "expected a populated node graph, got {}", data.len());

    // Every node has a non-empty, unique path; classes are bsi::ifc::*.
    // Paths are the entity's own GlobalId when it has one (see
    // `globalid_survives_ifc_to_ifcx_conversion` below) or a UUID-shaped
    // fallback otherwise — not uniformly hyphenated.
    let paths: HashSet<&str> = data.iter().filter_map(|n| n["path"].as_str()).collect();
    assert_eq!(paths.len(), data.len(), "paths are unique");
    for n in data {
        assert!(!n["path"].as_str().unwrap().is_empty(), "non-empty path");
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

/// The header key a READER looks for, which is not the same thing as the
/// key this exporter happens to write.
///
/// The assertion above was previously `header.version`, mirroring the
/// implementation — so it passed while every exported file was rejected by
/// `@ifc-lite/ifcx` ("missing or invalid header.ifcxVersion") and did not
/// match buildingSMART's own reference files either. Pinning the absence of
/// the old key is what makes that regression fail here instead of at the
/// other end of a round-trip.
#[test]
fn header_uses_the_key_readers_look_for() {
    let s = export_ifc5(&fixture_or_skip!("ara3d/duplex.ifc"), &Ifc5Options::default());
    let v: Value = serde_json::from_str(&s).expect("valid JSON");

    let header = v["header"].as_object().expect("header object");
    assert!(
        header.contains_key("ifcxVersion"),
        "header must carry ifcxVersion; got keys {:?}",
        header.keys().collect::<Vec<_>>(),
    );
    assert!(
        !header.contains_key("version"),
        "the old `version` key is what readers ignore — it must not come back",
    );
    // Readers match case-insensitively on the substring "ifcx".
    assert!(
        header["ifcxVersion"].as_str().unwrap().to_lowercase().contains("ifcx"),
        "ifcxVersion must contain 'ifcx'",
    );
}

#[test]
fn unknown_props_filtered_by_default() {
    let s = export_ifc5(&fixture_or_skip!("ara3d/duplex.ifc"), &Ifc5Options::default());
    // 'LoadBearing' / 'Reference' are IFC4 props NOT in the IFC5 known set.
    assert!(!s.contains("bsi::ifc::prop::LoadBearing"));
    assert!(!s.contains("bsi::ifc::prop::Reference\""));
}

/// Element identity (RED on unmodified `upstream/main`, GREEN after the fix).
///
/// `duplex.ifc`'s products already carry real IFC `GlobalId`s. Converting
/// to IFCX must not mint a fresh one: the source element's GlobalId is
/// exactly how a BCF topic, a diff tool, or any other external reference
/// keyed on the IFC file finds it again after conversion. Before this fix
/// `path_for_id` didn't exist and every product's path came from
/// `uuid_from_id(express_id)` — a hash unrelated to the source GlobalId —
/// so this assertion failed for every element in the fixture.
#[test]
fn globalid_survives_ifc_to_ifcx_conversion() {
    let bytes = fixture_or_skip!("ara3d/duplex.ifc");
    let model = build_export_model(&bytes);
    let wall = model
        .entities
        .iter()
        .find(|e| e.ifc_type == "IfcWall" && e.global_id.as_deref().is_some_and(|g| !g.is_empty()))
        .expect("fixture has a walled IfcWall with a GlobalId");
    let source_global_id = wall.global_id.clone().unwrap();

    let s = export_ifc5(&bytes, &Ifc5Options::default());
    let v: Value = serde_json::from_str(&s).expect("valid JSON");
    let data = v["data"].as_array().expect("data array");

    let paths: HashSet<&str> = data.iter().filter_map(|n| n["path"].as_str()).collect();
    assert!(
        paths.contains(source_global_id.as_str()),
        "expected the source IfcWall's GlobalId {source_global_id:?} to survive as an \
         IFCX node path — identity must not be regenerated for an element that already had one",
    );
}

/// Control: an entity with no GlobalId to carry (the `IfcProject` root,
/// decoded outside `model.entities`) still gets a stable, unique,
/// non-empty path via the deterministic fallback — unaffected by the fix
/// above, which only changes entities that *have* a GlobalId.
#[test]
fn project_root_without_globalid_still_gets_a_stable_path() {
    let bytes = fixture_or_skip!("ara3d/duplex.ifc");
    let s = export_ifc5(&bytes, &Ifc5Options::default());
    let v: Value = serde_json::from_str(&s).expect("valid JSON");
    let data = v["data"].as_array().expect("data array");

    let project = data
        .iter()
        .find(|n| n["attributes"]["bsi::ifc::class"]["code"] == "IfcProject")
        .expect("project node present");
    let path = project["path"].as_str().expect("project has a path");
    assert!(!path.is_empty(), "project path is non-empty");

    // Re-exporting is deterministic: the same input always yields the
    // same fallback path (no RNG/clock in `uuid_from_id`).
    let s2 = export_ifc5(&bytes, &Ifc5Options::default());
    let v2: Value = serde_json::from_str(&s2).expect("valid JSON");
    let path2 = v2["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["attributes"]["bsi::ifc::class"]["code"] == "IfcProject")
        .unwrap()["path"]
        .as_str()
        .unwrap();
    assert_eq!(path, path2, "fallback path is deterministic across runs");
}
