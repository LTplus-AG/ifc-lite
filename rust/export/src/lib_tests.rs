// SPDX-License-Identifier: MPL-2.0
//! Tests for `lib.rs`, split out under the house pattern (AGENTS.md).
//!
//! Moved out so the crate root stays under the module-size ratchet
//! (`rust/processing/tests/module_size_ratchet.rs`); this file is exempt via
//! the `_tests.rs` suffix convention.

use super::*;
use serde_json::Value;

/// Skip-if-absent fixture loader (matches the geometry crate convention — test
/// models are staged, not git-tracked, so a fresh checkout returns `None`).
#[test]
fn entity_count_reexport_matches_index() {
    // The re-exported cheap tally must equal the full index's entity count
    // (both walk the same scanner) — so a downstream can gate on the count
    // without paying for the index. Well-formed fixtures have unique ids, so
    // the index map length equals the scanned entity count.
    let Some(bytes) = crate::test_support::fixture_opt("ara3d/duplex.ifc") else {
        eprintln!(
            "skipping entity_count_reexport_matches_index: fixture absent — run `pnpm fixtures`"
        );
        return;
    };
    let counted = entity_count(&bytes);
    let indexed = build_entity_index(&bytes).len();
    assert!(counted > 0, "expected entities");
    assert_eq!(counted, indexed, "cheap count must match the index length");
}

#[test]
fn duplex_exports_valid_room_model() {
    let Some(bytes) = crate::test_support::fixture_opt("ara3d/duplex.ifc") else {
        return;
    };
    let (json, stats) = export_hbjson_with_stats(&bytes, &HbjsonOptions::default());
    // P2: windows and doors are placed on exterior walls.
    assert!(stats.apertures > 0, "expected windows, got {}", stats.apertures);
    assert!(stats.doors > 0, "expected doors, got {}", stats.doors);
    // P5: shared interior walls are paired as Surface adjacencies.
    assert!(stats.interior_adjacencies > 0, "expected interior adjacencies, got {}", stats.interior_adjacencies);
    // P4: material layer sets become opaque constructions assigned to faces.
    assert!(stats.constructions > 0, "expected constructions, got {}", stats.constructions);
    let v: Value = serde_json::from_str(&json).expect("valid JSON");

    // Energy + adjacency surface through the schema (materials, constructions, Surface BCs).
    let energy = &v["properties"]["energy"];
    assert_eq!(energy["type"], "ModelEnergyProperties");
    assert!(!energy["materials"].as_array().unwrap().is_empty());
    assert!(!energy["constructions"].as_array().unwrap().is_empty());
    let surface_faces = v["rooms"].as_array().unwrap().iter()
        .flat_map(|r| r["faces"].as_array().unwrap())
        .filter(|f| f["boundary_condition"]["type"] == "Surface")
        .count();
    assert!(surface_faces > 0, "expected Surface (interior) faces");
    // Every interior face references an adjacent [face, room].
    for r in v["rooms"].as_array().unwrap() {
        for f in r["faces"].as_array().unwrap() {
            if f["boundary_condition"]["type"] == "Surface" {
                assert_eq!(f["boundary_condition"]["boundary_condition_objects"].as_array().unwrap().len(), 2);
            }
        }
    }

    assert_eq!(v["type"], "Model");
    assert_eq!(v["units"], "Meters");
    assert_eq!(v["tolerance"], 0.01);

    let rooms = v["rooms"].as_array().expect("rooms array");
    assert!(rooms.len() >= 15, "expected >=15 IfcSpace rooms, got {}", rooms.len());

    // Every room must have exactly one Floor + one RoofCeiling + >=3 Walls.
    for room in rooms {
        let faces = room["faces"].as_array().unwrap();
        let mut floor = 0;
        let mut roof = 0;
        let mut wall = 0;
        for f in faces {
            match f["face_type"].as_str().unwrap() {
                "Floor" => floor += 1,
                "RoofCeiling" => roof += 1,
                "Wall" => wall += 1,
                other => panic!("unexpected face_type {other}"),
            }
            // boundary must be a non-degenerate polygon
            assert!(f["geometry"]["boundary"].as_array().unwrap().len() >= 3);
        }
        assert_eq!(floor, 1, "room {} floors", room["identifier"]);
        assert_eq!(roof, 1, "room {} roofs", room["identifier"]);
        assert!(wall >= 3, "room {} walls={}", room["identifier"], wall);
    }
}

/// Mutation killed: swapping `constructions::build_constructions`'s returned
/// `Constructions { wall, floor, roof }` (e.g. `wall: slab_id.clone(), floor:
/// wall_id.clone(), roof: wall_id`) survived the full suite — every existing
/// assertion only checks `stats.constructions > 0` / that the energy library is
/// non-empty, never which construction id lands on which `face_type`. This test
/// pins wall faces to the wall build-up and floor/roof faces to the slab build-up.
#[test]
fn duplex_faces_get_construction_by_face_type_not_swapped() {
    let Some(bytes) = crate::test_support::fixture_opt("ara3d/duplex.ifc") else {
        return;
    };
    let (json, stats) = export_hbjson_with_stats(&bytes, &HbjsonOptions::default());
    assert!(stats.constructions > 0, "expected constructions, got {}", stats.constructions);
    let v: Value = serde_json::from_str(&json).expect("valid JSON");

    let mut saw_wall_construction = false;
    let mut saw_slab_construction = false;
    for r in v["rooms"].as_array().unwrap() {
        for f in r["faces"].as_array().unwrap() {
            let Some(cons) = f["properties"]["energy"]["construction"].as_str() else {
                continue;
            };
            match f["face_type"].as_str().unwrap() {
                "Wall" => {
                    assert_eq!(cons, "ifclite_wall", "wall face got {cons}");
                    saw_wall_construction = true;
                }
                "Floor" | "RoofCeiling" => {
                    assert_eq!(cons, "ifclite_slab", "{} face got {cons}", f["face_type"]);
                    saw_slab_construction = true;
                }
                other => panic!("unexpected face_type {other}"),
            }
        }
    }
    assert!(saw_wall_construction, "expected at least one Wall face with a construction");
    assert!(saw_slab_construction, "expected at least one Floor/RoofCeiling face with a construction");
}

#[test]
fn revit_georeferenced_model_does_not_collapse() {
    // rvt01 carries national-grid coordinates (~2.78e6); the origin-rebase must keep
    // room footprints sane (no f32 collapse).
    let Some(bytes) = crate::test_support::fixture_opt("various/rvt01.ifc") else {
        return;
    };
    let (json, stats) = export_hbjson_with_stats(&bytes, &HbjsonOptions::default());
    // P2/P3: windows, doors and railing shades are all present on this Revit model.
    assert!(stats.apertures > 0 && stats.doors > 0, "openings: {} win / {} door", stats.apertures, stats.doors);
    assert!(stats.shades > 0, "expected railing shades, got {}", stats.shades);
    let v: Value = serde_json::from_str(&json).unwrap();
    let rooms = v["rooms"].as_array().unwrap();
    assert!(rooms.len() >= 30, "expected >=30 rooms, got {}", rooms.len());
    // No coordinate should exceed ~1km from the rebased origin.
    for room in rooms {
        for f in room["faces"].as_array().unwrap() {
            for p in f["geometry"]["boundary"].as_array().unwrap() {
                for c in p.as_array().unwrap() {
                    assert!(c.as_f64().unwrap().abs() < 1000.0, "coordinate not rebased: {c}");
                }
            }
        }
    }
}
