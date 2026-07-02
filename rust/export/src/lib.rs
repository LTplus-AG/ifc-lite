// SPDX-License-Identifier: MPL-2.0
//! Domain-format exporters for ifc-lite.
//!
//! Phase 1: **HBJSON** (Honeybee energy-model) room export — the analytic, watertight
//! IFC→Ladybug bridge. Apertures/doors/shades and a glTF migration follow.
//!
//! This is the Rust source of truth; CLI / SDK / wasm become thin callers (mirroring how
//! geometry already flows through `ifc-lite-wasm`).

mod adjacency;
mod constructions;
mod csv;
mod error;
mod frame;
mod geom;
mod gltf;
mod hbjson;
mod ifc5;
mod json;
mod jsonld;
mod kmz;
mod merged;
mod model;
mod obj;
mod openings;
#[cfg(feature = "parquet-bos")]
mod parquet_bos;
mod rooms;
mod schema_convert;
mod shades;
mod step;

pub use csv::{export_csv, CsvMode, CsvOptions};
pub use error::ExportError;
pub use gltf::{
    export_glb, export_glb_from_meshes, export_glb_with_stats, export_glb_with_stats_with_index,
    export_gltf_streaming, export_glb_streaming_bounded, try_export_glb,
    try_export_glb_with_stats, GltfBuffer, GltfOptions,
    GltfStats,
};
pub use hbjson::Model;
// Re-exported so a caller can `build_entity_index` once and share it across the
// geometry (`export_glb_with_stats_with_index`) and attribute
// (`stream_export_model_with_index`) passes.
//
// `entity_count` is the cheap `O(scan)`, `O(1)`-memory entity tally (issue
// #1517): a downstream DoS guard can reject a file with a pathological entity
// count WITHOUT forcing the full index (`build_entity_index(..).len()` would
// allocate ~20 B/entity — undoing the bounded-memory work).
pub use ifc_lite_core::{build_entity_index, entity_count, EntityIndex};
pub use ifc5::{export_ifc5, Ifc5Options};
pub use json::{export_json, JsonOptions};
pub use jsonld::{export_jsonld, JsonLdOptions};
pub use kmz::{export_kmz, ifc_angle_to_kml_heading, KmzOptions};
pub use merged::{export_merged, export_merged_with_stats, MergedOptions, MergedStats};
pub use model::{
    build_export_model, stream_export_model, stream_export_model_with_index, EntityRow,
    ExportModel, PropValue, PropertySet, QuantitySet, QuantityValue,
};
pub use obj::{export_obj, export_obj_with_stats, ObjOptions, ObjStats};
#[cfg(feature = "parquet-bos")]
pub use parquet_bos::{export_bos, ParquetBosOptions};
pub use step::{
    export_step, export_step_json, export_step_with_stats, AttrMutation, PropMutation, StepOptions,
    StepStats,
};

use ifc_lite_geometry::extract_profiles;

/// Honeybee identifiers may not contain spaces or most special characters; map anything
/// other than alphanumerics / `_` / `-` to `_`.
fn sanitize_identifier(s: &str) -> String {
    let out: String = s
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .collect();
    if out.is_empty() { "model".to_string() } else { out }
}

/// Options for HBJSON export.
pub struct HbjsonOptions {
    /// Model identifier / display name.
    pub name: String,
    /// Geometry tolerance in metres (Honeybee default 0.01).
    pub tolerance: f64,
}

impl Default for HbjsonOptions {
    fn default() -> Self {
        Self { name: "ifc_lite_model".to_string(), tolerance: 0.01 }
    }
}

/// Coverage stats for an HBJSON export.
pub struct HbjsonStats {
    /// `IfcSpace` profiles seen in the model.
    pub spaces: usize,
    /// Rooms emitted (watertight prisms).
    pub rooms: usize,
    /// Spaces skipped as degenerate (malformed footprint / holes / non-extrusion — P5).
    pub skipped: usize,
    /// Windows placed as Apertures on exterior wall faces.
    pub apertures: usize,
    /// Doors placed on exterior wall faces.
    pub doors: usize,
    /// Railing / context shade meshes emitted.
    pub shades: usize,
    /// Opaque constructions derived from the IFC material layer sets.
    pub constructions: usize,
    /// Interior faces paired as `Surface` adjacencies (2 per shared wall).
    pub interior_adjacencies: usize,
}

/// Export the `IfcSpace` volumes in `content` (raw IFC/STEP bytes) as an HBJSON string.
///
/// Rooms are built analytically from extruded-area profiles (watertight by construction);
/// faces are typed Floor / RoofCeiling / Wall with outward normals. Returns a Honeybee-valid
/// `Model` JSON ready to load via `honeybee.model.Model.from_hbjson`.
pub fn export_hbjson(content: &[u8], opts: &HbjsonOptions) -> String {
    export_hbjson_with_stats(content, opts).0
}

/// Like [`export_hbjson`] but also returns coverage stats (so callers can report how many
/// spaces were skipped instead of silently truncating).
pub fn export_hbjson_with_stats(content: &[u8], opts: &HbjsonOptions) -> (String, HbjsonStats) {
    let profiles = extract_profiles(content, 0);
    let spaces = profiles.iter().filter(|p| p.ifc_type == "IfcSpace").count();
    let (mut rooms, origin, skipped) = rooms::build_rooms(&profiles, opts.tolerance);
    openings::attach_openings(&profiles, &mut rooms, origin);
    // Pair shared interior walls as Surface adjacencies (drops their exterior openings).
    let interior_adjacencies = adjacency::solve_adjacency(&mut rooms);
    let shade_meshes = shades::build_shades(&profiles, origin);

    // Assign representative opaque constructions (from the IFC material layer sets) by face type.
    let cons = constructions::build_constructions(content, &profiles);
    for room in &mut rooms {
        for f in &mut room.faces {
            let id = match f.face_type {
                "Wall" => cons.wall.clone(),
                "Floor" => cons.floor.clone(),
                "RoofCeiling" => cons.roof.clone(),
                _ => None,
            };
            if let Some(id) = id {
                f.set_construction(id);
            }
        }
    }

    let apertures = rooms.iter().flat_map(|r| &r.faces).map(|f| f.apertures.len()).sum();
    let doors = rooms.iter().flat_map(|r| &r.faces).map(|f| f.doors.len()).sum();
    let shades = shade_meshes.len();
    let n_constructions = cons.energy.as_ref().map_or(0, |e| e.constructions.len());
    let stats = HbjsonStats { spaces, rooms: rooms.len(), skipped, apertures, doors, shades, constructions: n_constructions, interior_adjacencies };

    let model = Model::new(&sanitize_identifier(&opts.name), rooms, shade_meshes, cons.energy, opts.tolerance);
    let json = serde_json::to_string(&model).expect("HBJSON model serializes");
    (json, stats)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// Skip-if-absent fixture loader (matches the geometry crate convention — test
    /// models are staged, not git-tracked, so a fresh checkout returns `None`).
    fn fixture(rel: &str) -> Option<Vec<u8>> {
        let path = format!("{}/../../tests/models/{}", env!("CARGO_MANIFEST_DIR"), rel);
        std::fs::read(path).ok()
    }

    #[test]
    fn entity_count_reexport_matches_index() {
        // The re-exported cheap tally must equal the full index's entity count
        // (both walk the same scanner) — so a downstream can gate on the count
        // without paying for the index. Well-formed fixtures have unique ids, so
        // the index map length equals the scanned entity count.
        let Some(bytes) = fixture("ara3d/duplex.ifc") else {
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
        let Some(bytes) = fixture("ara3d/duplex.ifc") else {
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

    #[test]
    fn revit_georeferenced_model_does_not_collapse() {
        // rvt01 carries national-grid coordinates (~2.78e6); the origin-rebase must keep
        // room footprints sane (no f32 collapse).
        let Some(bytes) = fixture("various/rvt01.ifc") else {
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
}
