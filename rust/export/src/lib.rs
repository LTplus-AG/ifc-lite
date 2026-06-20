// SPDX-License-Identifier: MPL-2.0
//! Domain-format exporters for ifc-lite.
//!
//! This is the Rust source of truth for domain-format export; CLI / SDK / wasm become
//! thin callers (mirroring how geometry already flows through `ifc-lite-wasm`).
//!
//! Formats:
//! - **HBJSON** (Honeybee energy-model): analytic, watertight `IfcSpace` → room export.
//! - **OBJ** (Wavefront): triangulated render geometry, origin-folded world coords.
//! - **glTF/GLB**: binary glTF container with RGBA-deduped unlit materials.

mod csv;
mod gltf;
mod hbjson;
mod json;
mod jsonld;
mod model;
mod obj;
#[cfg(feature = "parquet-bos")]
mod parquet_bos;
mod rooms;
mod schema_convert;
mod step;

pub use csv::{export_csv, CsvMode, CsvOptions};
pub use step::{export_step, export_step_with_stats, StepOptions, StepStats};
#[cfg(feature = "parquet-bos")]
pub use parquet_bos::{export_bos, ParquetBosOptions};
pub use gltf::{
    export_glb, export_glb_from_meshes, export_glb_with_stats, GltfOptions, GltfStats,
};
pub use hbjson::Model;
pub use json::{export_json, JsonOptions};
pub use jsonld::{export_jsonld, JsonLdOptions};
pub use model::{
    build_export_model, EntityRow, ExportModel, PropValue, PropertySet, QuantitySet, QuantityValue,
};
pub use obj::{export_obj, export_obj_with_stats, ObjOptions, ObjStats};

use ifc_lite_geometry::extract_profiles;

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
    let (rooms, skipped) = rooms::build_rooms(&profiles, opts.tolerance);
    let stats = HbjsonStats { spaces, rooms: rooms.len(), skipped };
    let model = Model::new(&opts.name, rooms, opts.tolerance);
    let json = serde_json::to_string(&model).expect("HBJSON model serializes");
    (json, stats)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn fixture(rel: &str) -> Vec<u8> {
        let path = format!("{}/../../tests/models/{}", env!("CARGO_MANIFEST_DIR"), rel);
        std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"))
    }

    #[test]
    fn duplex_exports_valid_room_model() {
        let json = export_hbjson(&fixture("ara3d/duplex.ifc"), &HbjsonOptions::default());
        let v: Value = serde_json::from_str(&json).expect("valid JSON");

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
        let json = export_hbjson(&fixture("various/rvt01.ifc"), &HbjsonOptions::default());
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
