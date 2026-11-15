// SPDX-License-Identifier: MPL-2.0
//! CityJSON export of real authoring-tool models (catalogued fixtures; each
//! test skips when `pnpm fixtures` has not fetched its model).
//!
//! Set `IFC_LITE_CITYJSON_OUT=<dir>` to keep the documents for an external
//! validator (cjval) run.

use serde_json::Value;

use super::tests::{assert_valid, lod, real_vertices, surfaces};
use crate::cityjson::{try_export_cityjson, CityJsonExport, CityJsonOptions};
use crate::scene_input::gather;

fn run(rel: &str, bytes: &[u8]) -> (CityJsonExport, Value) {
    let out = try_export_cityjson(bytes, &CityJsonOptions::default()).expect("export");
    if let Ok(dir) = std::env::var("IFC_LITE_CITYJSON_OUT") {
        let name = rel.rsplit('/').next().unwrap().replace(".ifc", ".city.json");
        std::fs::write(std::path::Path::new(&dir).join(&name), &out.text).expect("write");
        let seq = CityJsonOptions { sequence: true, ..CityJsonOptions::default() };
        let lines = try_export_cityjson(bytes, &seq).expect("sequence export").text;
        std::fs::write(std::path::Path::new(&dir).join(name.replace(".city.json", ".city.jsonl")), lines).expect("write");
    }
    let doc: Value = serde_json::from_str(&out.text).unwrap();
    assert_valid(&doc);
    (out, doc)
}

fn of_type<'a>(doc: &'a Value, t: &str) -> Vec<(&'a String, &'a Value)> {
    doc["CityObjects"].as_object().unwrap().iter().filter(|(_, o)| o["type"] == t).collect()
}

/// buildingSMART sample house: EPSG:32760, millimetre map unit, the map
/// conversion rotated by 60°. Control point: a real mesh vertex of the model,
/// taken through the IfcMapConversion by hand, must be an output vertex.
#[test]
fn building_architecture_is_georeferenced_through_its_rotated_mm_conversion() {
    let rel = "buildingsmart/Building-Architecture.ifc";
    let bytes = fixture_or_skip!(rel);
    let (out, doc) = run(rel, &bytes);
    assert_eq!(out.reference_system.as_deref(), Some("https://www.opengis.net/def/crs/EPSG/0/32760"), "{:?}", out.warnings);
    assert_eq!(out.buildings, 1);
    // #19=IFCMAPCONVERSION(#11,#18,729013348.8297004,9063992684.697363,1300.0000000000011,0.4999999999999999,0.8660254037844387,1.)
    // in millimetres (project and map unit), written in metres.
    let (e0, n0, h0, c, s) = (729013348.8297004_f64, 9063992684.697363_f64, 1300.0000000000011_f64, 0.4999999999999999_f64, 0.8660254037844387_f64);
    let scene = gather(&bytes, false, false, None);
    let world = scene.result.frame.world_mapper();
    let m = scene.emittable().find(|m| m.ifc_type.eq_ignore_ascii_case("IfcWall")).expect("a wall mesh");
    let p = world([m.origin[0] + m.positions[0] as f64, m.origin[1] + m.positions[1] as f64, m.origin[2] + m.positions[2] as f64]);
    let (x, y, z) = (p[0] * 1000.0, p[1] * 1000.0, p[2] * 1000.0); // mesh metres → project mm
    let expect = [(c * x - s * y + e0) / 1000.0, (s * x + c * y + n0) / 1000.0, (z + h0) / 1000.0];
    let verts = real_vertices(&doc);
    let hit = verts.iter().any(|v| (0..3).all(|k| (v[k] - expect[k]).abs() <= 0.0005 + 1e-9));
    assert!(hit, "control point {expect:?} not among the output vertices");
    let (_, b) = of_type(&doc, "Building")[0];
    assert_eq!(lod(b, "1")["type"], "Solid");
    assert!(b["attributes"]["measuredHeight"].as_f64().unwrap() > 2.0);
    assert!(!of_type(&doc, "BuildingRoom").is_empty());
    assert!(!of_type(&doc, "BuildingConstructiveElement").is_empty());
}

/// Dutch multi-storey house in RD New (EPSG:28992): eleven storeys, every
/// one a BuildingStorey of the one building, and elements tagged with theirs.
#[test]
fn minibim_storeys_in_rd_new() {
    let rel = "georeferencer/MiniBIM-3.1-DO_01_VORM.ifc";
    let bytes = fixture_or_skip!(rel);
    let (out, doc) = run(rel, &bytes);
    assert_eq!(out.reference_system.as_deref(), Some("https://www.opengis.net/def/crs/EPSG/0/28992"), "{:?}", out.warnings);
    let storeys = of_type(&doc, "BuildingStorey");
    assert_eq!(storeys.len(), 11);
    let storey_ids: std::collections::HashSet<&str> = storeys.iter().map(|(id, _)| id.as_str()).collect();
    let tagged = doc["CityObjects"].as_object().unwrap().values()
        .filter_map(|o| o["attributes"]["ifcBuildingStorey"].as_str())
        .filter(|s| storey_ids.contains(s))
        .count();
    assert!(tagged > 0);
    // RD New around (90770, 435320): the building lands there.
    let e = doc["metadata"]["geographicalExtent"].as_array().unwrap();
    let (x, y) = (e[0].as_f64().unwrap(), e[1].as_f64().unwrap());
    assert!((90_000.0..92_000.0).contains(&x) && (434_000.0..437_000.0).contains(&y), "{e:?}");
}

/// KIT FZK-Haus: no IfcMapConversion, so local coordinates and a warning.
#[test]
fn fzk_haus_is_local() {
    let rel = "ara3d/AC20-FZK-Haus.ifc";
    let bytes = fixture_or_skip!(rel);
    let (out, doc) = run(rel, &bytes);
    assert!(out.reference_system.is_none());
    assert!(out.warnings.iter().any(|w| w.contains("not georeferenced")), "{:?}", out.warnings);
    assert_eq!(of_type(&doc, "BuildingStorey").len(), 2);
    let (_, b) = of_type(&doc, "Building")[0];
    assert!(!surfaces(lod(b, "0")).is_empty());
}

/// buildingSMART road sample: a COMPLEX IfcBuilding decomposed into PARTIAL
/// ones, which become BuildingParts.
#[test]
fn infra_road_partial_buildings_are_building_parts() {
    let rel = "buildingsmart/Infra-Road.ifc";
    let bytes = fixture_or_skip!(rel);
    let (out, doc) = run(rel, &bytes);
    assert_eq!(out.reference_system.as_deref(), Some("https://www.opengis.net/def/crs/EPSG/0/32760"), "{:?}", out.warnings);
    let parts = of_type(&doc, "BuildingPart");
    assert!(!parts.is_empty());
    for (id, p) in parts {
        let parent = p["parents"][0].as_str().unwrap();
        let t = doc["CityObjects"][parent]["type"].as_str().unwrap();
        assert!(t == "Building" || t == "BuildingPart", "{id} under {t}");
    }
}
